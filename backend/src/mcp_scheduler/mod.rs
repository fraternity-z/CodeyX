//! Opt-in, bounded stdio MCP multiplexing. Configuration remains owned by extensions.
mod io;
pub(crate) mod process;
#[cfg(test)]
mod relay_tests;
#[cfg(test)]
mod tests;

use anyhow::{Result, anyhow, bail, ensure};
use codey_codex_extensions::{ExtensionService, SharedMcpRegistration};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::BufReader,
    net::{TcpListener, TcpStream},
    sync::{Notify, mpsc, watch},
    time::Instant,
};

const QUEUE_LIMIT: usize = 32;
const IDLE: Duration = Duration::from_secs(30);
const MAX_POOLS: usize = 128;

#[derive(Serialize, Deserialize)]
struct Discovery {
    address: String,
    token: String,
}

#[derive(Deserialize)]
struct Hello {
    token: String,
    registration: String,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
}

struct Host {
    service: ExtensionService,
    pools: Mutex<HashMap<String, Arc<Pool>>>,
    stopped: AtomicBool,
    shutdown: watch::Sender<bool>,
    token: String,
}

impl Host {
    async fn registration(self: &Arc<Self>, id: &str) -> Result<SharedMcpRegistration> {
        let host = self.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || host.service.shared_mcp_registration(&id))
            .await
            .map_err(|_| anyhow!("读取 MCP 共享登记任务异常退出"))?
    }
}

pub struct Scheduler {
    host: Arc<Host>,
    discovery: PathBuf,
    listener: tokio::task::JoinHandle<()>,
    maintenance: tokio::task::JoinHandle<()>,
    _lock: std::fs::File,
}

pub async fn start(
    codex_home: PathBuf,
    data_dir: PathBuf,
    user_home: PathBuf,
) -> Result<Scheduler> {
    let directory = data_dir.clone();
    let (lock, discovery) = tokio::task::spawn_blocking(move || {
        checked_directory(&directory)?;
        std::fs::create_dir_all(&directory)?;
        checked_directory(&directory)?;
        let lock_path = directory.join("mcp-scheduler.lock");
        checked_optional_file(&lock_path)?;
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(lock_path)?;
        fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| anyhow!("MCP 调度器已运行"))?;
        let discovery = directory.join("mcp-scheduler.json");
        // Replace stale regular files atomically only after acquiring the lifetime lock.
        checked_optional_file(&discovery)?;
        Ok::<_, anyhow::Error>((lock, discovery))
    })
    .await
    .map_err(|_| anyhow!("准备 MCP 调度目录任务异常退出"))??;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let token = uuid::Uuid::new_v4().to_string();
    let path = discovery.clone();
    let bytes = serde_json::to_vec(&Discovery {
        address: listener.local_addr()?.to_string(),
        token: token.clone(),
    })?;
    tokio::task::spawn_blocking(move || private_discovery(&path, &bytes))
        .await
        .map_err(|_| anyhow!("写入 MCP 发现文件任务异常退出"))??;
    let (shutdown, _) = watch::channel(false);
    let host = Arc::new(Host {
        service: ExtensionService::new(codex_home, data_dir, user_home),
        pools: Mutex::new(HashMap::new()),
        stopped: AtomicBool::new(false),
        shutdown,
        token,
    });
    let accept_host = host.clone();
    let listener = tokio::spawn(async move {
        let permits = Arc::new(tokio::sync::Semaphore::new(128));
        let mut stopped = accept_host.shutdown.subscribe();
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break; };
                    let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                    let host = accept_host.clone();
                    tokio::spawn(async move { let _permit = permit; let _ = connection(host, stream).await; });
                }
            }
        }
    });
    let maintain_host = host.clone();
    let maintenance = tokio::spawn(async move {
        let mut stopped = maintain_host.shutdown.subscribe();
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                _ = interval.tick() => {
                    let pools: Vec<_> = maintain_host.pools.lock().unwrap().values().cloned().collect();
                    for pool in pools { pool.shrink(false).await; }
                    maintain_host.pools.lock().unwrap().retain(|_, pool| !pool.stopped.load(Ordering::Acquire) || !pool.slots.lock().unwrap().is_empty());
                }
            }
        }
    });
    Ok(Scheduler {
        host,
        discovery,
        listener,
        maintenance,
        _lock: lock,
    })
}

impl Scheduler {
    /// Release idle backends without interrupting calls; later calls restart on demand.
    pub async fn release_idle(&self) -> usize {
        let pools: Vec<_> = self.host.pools.lock().unwrap().values().cloned().collect();
        let counts =
            futures_util::future::join_all(pools.iter().map(|pool| pool.shrink(true))).await;
        counts.into_iter().sum()
    }

    pub fn status(&self) -> Value {
        let pools: Vec<_> = self.host.pools.lock().unwrap().values().map(|pool| {
            let slots = pool.slots.lock().unwrap();
            json!({"registrationId":pool.registration.registration_id,"id":pool.registration.id,"sourcePath":pool.registration.source_path,
                "instances":slots.iter().filter(|s| s.is_live()).count(),"running":slots.iter().filter(|s| s.busy.load(Ordering::Acquire)).count(),
                "queued":pool.queued.load(Ordering::Acquire),"error":pool.error.lock().unwrap().clone()})
        }).collect();
        json!({"pools":pools})
    }

    pub async fn reconcile(&self) {
        let pools: Vec<_> = self.host.pools.lock().unwrap().values().cloned().collect();
        for pool in pools {
            let valid = self
                .host
                .registration(&pool.registration.registration_id)
                .await
                .is_ok_and(|current| {
                    current.config == pool.registration.config
                        && current.max_instances == pool.registration.max_instances
                });
            if !valid {
                pool.stopped.store(true, Ordering::Release);
                pool.notify.notify_waiters();
                pool.shrink(false).await;
            }
        }
    }

    pub async fn stop(&self) {
        self.host.stopped.store(true, Ordering::Release);
        self.host.shutdown.send_replace(true);
        self.listener.abort();
        self.maintenance.abort();
        let pools: Vec<_> = self.host.pools.lock().unwrap().values().cloned().collect();
        let mut all_slots = Vec::new();
        for pool in pools {
            pool.stopped.store(true, Ordering::Release);
            pool.notify.notify_waiters();
            all_slots.extend(pool.slots.lock().unwrap().clone());
        }
        futures_util::future::join_all(all_slots.into_iter().map(|slot| async move {
            let mut guard = slot.worker.lock().await;
            if let Some(mut worker) = guard.take() {
                worker.process.close().await;
            }
        }))
        .await;
        let discovery = self.discovery.clone();
        let token = self.host.token.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if checked_directory(discovery.parent().unwrap()).is_ok()
                && checked_optional_file(&discovery).is_ok()
                && let Ok(bytes) = crate::fs_util::read_bounded(&discovery, 4096)
                && serde_json::from_slice::<Discovery>(&bytes).is_ok_and(|d| d.token == token)
            {
                let _ = std::fs::remove_file(discovery);
            }
        })
        .await;
    }
}

fn ordinary(metadata: &std::fs::Metadata) -> bool {
    let linked = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        linked || metadata.file_attributes() & 0x400 != 0
    };
    !linked
}

fn checked_directory(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) => ensure!(
                ordinary(&metadata) && metadata.is_dir(),
                "MCP 调度目录包含链接或特殊文件"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn checked_optional_file(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            ensure!(
                ordinary(&metadata) && metadata.is_file(),
                "MCP 调度文件必须为普通文件"
            );
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

impl Drop for Scheduler {
    fn drop(&mut self) {
        self.host.stopped.store(true, Ordering::Release);
        self.host.shutdown.send_replace(true);
        self.listener.abort();
        self.maintenance.abort();
    }
}

struct Pool {
    registration: SharedMcpRegistration,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
    initialize: Value,
    slots: Mutex<Vec<Arc<Slot>>>,
    queued: AtomicUsize,
    stopped: AtomicBool,
    notify: Notify,
    error: Mutex<Option<String>>,
    events: tokio::sync::broadcast::Sender<Value>,
    admission: tokio::sync::Mutex<()>,
}

struct Slot {
    busy: AtomicBool,
    used: Mutex<Instant>,
    worker: tokio::sync::Mutex<Option<Worker>>,
}

impl Slot {
    fn is_live(&self) -> bool {
        if self.busy.load(Ordering::Acquire) {
            return true;
        }
        match self.worker.try_lock() {
            Ok(mut worker) => worker
                .as_mut()
                .is_some_and(|worker| worker.process.is_running()),
            // An idle worker can also be locked while its process is closing.
            Err(_) => true,
        }
    }
}

struct Reservation<'a> {
    pool: &'a Pool,
    slot: Arc<Slot>,
}
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        *self.slot.used.lock().unwrap() = Instant::now();
        self.slot.busy.store(false, Ordering::Release);
        self.pool.notify.notify_one();
    }
}
struct Queued<'a>(&'a AtomicUsize);
impl Drop for Queued<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Pool {
    async fn acquire(&self) -> Result<Reservation<'_>> {
        let previous = self.queued.fetch_add(1, Ordering::AcqRel);
        let _queued = Queued(&self.queued);
        ensure!(previous < QUEUE_LIMIT, "MCP 调度队列已满，请稍后重试");
        // Tokio's FIFO mutex keeps new callers behind existing waiters, including at capacity.
        let _admission = self.admission.lock().await;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            ensure!(
                !self.stopped.load(Ordering::Acquire),
                "MCP 共享配置已失效，请重新连接"
            );
            {
                let mut slots = self.slots.lock().unwrap();
                if let Some(slot) = slots.iter().find(|s| {
                    s.busy
                        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                }) {
                    return Ok(Reservation {
                        pool: self,
                        slot: slot.clone(),
                    });
                }
                if slots.len() < self.registration.max_instances.clamp(1, 8) {
                    let slot = Arc::new(Slot {
                        busy: AtomicBool::new(true),
                        used: Mutex::new(Instant::now()),
                        worker: tokio::sync::Mutex::new(None),
                    });
                    slots.push(slot.clone());
                    return Ok(Reservation { pool: self, slot });
                }
            }
            notified.await;
        }
    }

    async fn execute(
        &self,
        message: Value,
        output: mpsc::Sender<Value>,
        mut cancelled: watch::Receiver<bool>,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<Value> {
        ensure!(!*shutdown.borrow(), "MCP 调度器正在退出");
        let limit = seconds(&self.registration.config, "tool_timeout_sec", 60.0);
        let operation = async {
            let reservation = tokio::select! {
                biased;
                _ = cancelled.changed() => bail!("MCP 调用已取消"),
                result = self.acquire() => result?,
            };
            let mut guard = reservation.slot.worker.lock().await;
            let mut worker = match guard.take() {
                Some(worker) => worker,
                None => tokio::select! {
                    biased;
                    _ = cancelled.changed() => bail!("MCP 调用已取消"),
                    result = Worker::start(self) => result?,
                },
            };
            let result = if message["method"] == "initialize" {
                Ok(worker.initialized.clone())
            } else {
                worker.call(message, &output, &mut cancelled).await
            };
            if result.is_ok() {
                *guard = Some(worker);
            }
            result
        };
        let result = tokio::select! {
            biased;
            _ = shutdown.changed() => Err(anyhow!("MCP 调度器正在退出")),
            result = tokio::time::timeout(limit, operation) => result.map_err(|_| anyhow!("MCP 调用超时（包含排队时间）")).and_then(|r| r),
        };
        *self.error.lock().unwrap() = result.as_ref().err().map(|e| e.to_string());
        result
    }

    async fn shrink(&self, release_all: bool) -> usize {
        let removed = {
            let mut slots = self.slots.lock().unwrap();
            let mut removed = Vec::new();
            let mut index = slots.len();
            while index > 0 {
                index -= 1;
                if !slots[index].busy.load(Ordering::Acquire)
                    && (release_all
                        || self.stopped.load(Ordering::Acquire)
                        || (index > 0 && slots[index].used.lock().unwrap().elapsed() >= IDLE))
                {
                    removed.push(slots.remove(index));
                }
            }
            removed
        };
        let count = removed.len();
        for slot in removed {
            if let Some(mut worker) = slot.worker.lock().await.take() {
                worker.process.close().await;
            }
        }
        count
    }
}

fn seconds(config: &Value, key: &str, default: f64) -> Duration {
    Duration::from_secs_f64(
        config
            .get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n > 0.0)
            .unwrap_or(default)
            .min(86400.0),
    )
}

pub(crate) fn startup_timeout(config: &Value) -> Duration {
    seconds(config, "startup_timeout_sec", 10.0)
}

struct Worker {
    process: process::Process,
    initialized: Value,
    messages: mpsc::Receiver<Result<Value>>,
    reader: tokio::task::JoinHandle<()>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.reader.abort();
    }
}
impl Worker {
    async fn start(pool: &Pool) -> Result<Self> {
        tokio::time::timeout(startup_timeout(&pool.registration.config), async {
            let mut process = process::Process::spawn(&pool.registration.config, &pool.cwd, &pool.env).await?;
            let request = json!({"jsonrpc":"2.0","id":"codey-initialize","method":"initialize","params":pool.initialize});
            io::write(process.input.as_mut().ok_or_else(|| anyhow!("MCP 输入已关闭"))?, &request).await?;
            let response = io::read(process.output.as_mut().unwrap()).await?.ok_or_else(|| anyhow!("MCP 在握手前退出"))?;
            ensure!(response["jsonrpc"] == "2.0" && response.get("method").is_none() && response["id"] == "codey-initialize" && response.get("error").is_none(), "MCP 握手失败");
            let initialized = response.get("result").cloned().ok_or_else(|| anyhow!("MCP 握手缺少结果"))?;
            validate_capabilities(&initialized)?;
            io::write(process.input.as_mut().unwrap(), &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await?;
            let mut stdout = process.output.take().unwrap();
            let (sender, messages) = mpsc::channel(32);
            let events = pool.events.clone();
            let reader = tokio::spawn(async move {
                loop {
                    match io::read(&mut stdout).await {
                        Ok(Some(message)) if message["jsonrpc"] == "2.0" && message["method"] == "notifications/tools/list_changed" && message.get("id").is_none() => { let _ = events.send(message); }
                        Ok(Some(message)) => { if sender.send(Ok(message)).await.is_err() { break; } }
                        outcome => { let error = outcome.err().unwrap_or_else(|| anyhow!("MCP 后端已退出；本次调用未重试")); let _ = sender.send(Err(error)).await; break; }
                    }
                }
            });
            Ok(Self { process, initialized, messages, reader })
        }).await.map_err(|_| anyhow!("MCP 启动握手超时"))?
    }

    async fn call(
        &mut self,
        mut message: Value,
        output: &mpsc::Sender<Value>,
        cancelled: &mut watch::Receiver<bool>,
    ) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        message["id"] = json!(id);
        let progress = message.pointer("/params/_meta/progressToken").cloned();
        if progress.is_some() {
            message["params"]["_meta"]["progressToken"] = json!(id);
        }
        io::write(
            self.process
                .input
                .as_mut()
                .ok_or_else(|| anyhow!("MCP 输入已关闭"))?,
            &message,
        )
        .await?;
        loop {
            let mut response = tokio::select! {
                biased;
                _ = cancelled.changed() => {
                    let _ = tokio::time::timeout(Duration::from_millis(100), io::write(self.process.input.as_mut().unwrap(), &json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id}}))).await;
                    bail!("MCP 调用已取消");
                }
                message = self.messages.recv() => message.ok_or_else(|| anyhow!("MCP 后端已退出；本次调用未重试"))??,
            };
            ensure!(response["jsonrpc"] == "2.0", "MCP 返回无效协议消息");
            if response.get("id").is_some() {
                ensure!(
                    response.get("method").is_none() && response["id"] == id,
                    "MCP 返回回调或不匹配的响应；请关闭共享"
                );
                ensure!(
                    response.get("result").is_some() ^ response.get("error").is_some(),
                    "MCP 响应必须包含结果或错误"
                );
                response.as_object_mut().unwrap().remove("id");
                return Ok(response);
            }
            match response["method"].as_str() {
                Some("notifications/progress")
                    if progress.is_some() && response["params"]["progressToken"] == id =>
                {
                    response["params"]["progressToken"] = progress.clone().unwrap();
                    output
                        .send(response)
                        .await
                        .map_err(|_| anyhow!("MCP 客户端已断开"))?;
                }
                _ => bail!("MCP 返回共享模式不支持的通知；请关闭共享"),
            }
        }
    }
}

/// Validate the unredacted `result` object from a backend's initialize response.
pub(crate) fn validate_capabilities(result: &Value) -> Result<()> {
    let capabilities = result["capabilities"]
        .as_object()
        .ok_or_else(|| anyhow!("MCP 缺少能力声明"))?;
    ensure!(
        capabilities.get("tools").is_some_and(Value::is_object),
        "共享模式仅支持工具型 MCP"
    );
    ensure!(
        capabilities.keys().all(|key| key == "tools"),
        "MCP 包含共享模式不支持的能力，请保留直连"
    );
    ensure!(
        result["protocolVersion"].is_string() && result["serverInfo"].is_object(),
        "MCP 握手信息无效"
    );
    Ok(())
}

fn pool_key(
    registration: &SharedMcpRegistration,
    hello: &Hello,
    initialize: &Value,
) -> Result<String> {
    let context = json!([
        registration.registration_id,
        registration.source_path,
        registration.config,
        registration.max_instances,
        hello.cwd,
        hello.env,
        initialize
    ]);
    Ok(crate::fs_util::sha256_hex(&serde_json::to_vec(&context)?))
}

fn rpc_error(id: Value, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}})
}

async fn connection(host: Arc<Host>, stream: TcpStream) -> Result<()> {
    stream.set_nodelay(true)?;
    let (read, mut write) = stream.into_split();
    let mut read = BufReader::new(read);
    let hello = tokio::time::timeout(Duration::from_secs(5), io::read(&mut read))
        .await??
        .ok_or_else(|| anyhow!("MCP 缺少认证"))?;
    let hello: Hello = serde_json::from_value(hello).map_err(|_| anyhow!("MCP 认证格式无效"))?;
    ensure!(
        hello.token == host.token && !host.stopped.load(Ordering::Acquire),
        "MCP 调度认证失败"
    );
    ensure!(
        hello.cwd.is_absolute() && hello.cwd.is_dir(),
        "MCP 工作目录无效"
    );
    let registration = match host.registration(&hello.registration).await {
        Ok(registration) => registration,
        Err(_) => {
            io::write(
                &mut write,
                &rpc_error(Value::Null, "MCP 共享登记已失效，请检查配置或恢复直连"),
            )
            .await?;
            return Ok(());
        }
    };
    let first = tokio::time::timeout(Duration::from_secs(30), io::read(&mut read))
        .await??
        .ok_or_else(|| anyhow!("MCP 缺少初始化"))?;
    ensure!(
        first["method"] == "initialize" && first.get("id").is_some(),
        "MCP 首条消息必须为初始化请求"
    );
    let mut initialize = first
        .get("params")
        .cloned()
        .ok_or_else(|| anyhow!("MCP 初始化缺少参数"))?;
    if !initialize["capabilities"].is_object() {
        io::write(
            &mut write,
            &rpc_error(first["id"].clone(), "MCP 客户端能力声明无效"),
        )
        .await?;
        return Ok(());
    }
    let key = pool_key(&registration, &hello, &initialize)?;
    // Client capabilities are optional; the shared backend must not request callbacks.
    initialize["capabilities"] = json!({});
    let pool = {
        let mut pools = host.pools.lock().unwrap();
        ensure!(!host.stopped.load(Ordering::Acquire), "MCP 调度器正在退出");
        ensure!(
            pools.len() < MAX_POOLS || pools.contains_key(&key),
            "MCP 共享上下文数量已达上限"
        );
        if pools
            .get(&key)
            .is_some_and(|pool| pool.stopped.load(Ordering::Acquire))
        {
            pools.remove(&key);
        }
        pools
            .entry(key)
            .or_insert_with(|| {
                Arc::new(Pool {
                    registration,
                    cwd: hello.cwd,
                    env: hello.env,
                    initialize,
                    slots: Mutex::new(Vec::new()),
                    queued: AtomicUsize::new(0),
                    stopped: AtomicBool::new(false),
                    notify: Notify::new(),
                    error: Mutex::new(None),
                    events: tokio::sync::broadcast::channel(32).0,
                    admission: tokio::sync::Mutex::new(()),
                })
            })
            .clone()
    };
    let (output, mut responses) = mpsc::channel::<Value>(QUEUE_LIMIT);
    let mut events = pool.events.subscribe();
    let event_output = output.clone();
    let notifications = tokio::spawn(async move {
        while let Ok(message) = events.recv().await {
            if event_output.send(message).await.is_err() {
                break;
            }
        }
    });
    let mut shutdown = host.shutdown.subscribe();
    let writer = tokio::spawn(async move {
        while let Some(value) = responses.recv().await {
            io::write(&mut write, &value).await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let pending = Arc::new(Mutex::new(HashMap::<String, watch::Sender<bool>>::new()));
    let mut next = Some(first);
    let mut first_request = true;
    let outcome = async {
        loop {
            let message = match next.take() {
                Some(value) => value,
                None => tokio::select! { _ = shutdown.changed() => break, result = io::read(&mut read) => match result? { Some(value) => value, None => break } },
            };
            ensure!(message["jsonrpc"] == "2.0", "MCP JSON-RPC 版本无效");
            let method = message["method"].as_str().ok_or_else(|| anyhow!("MCP 请求缺少方法"))?;
            if method == "notifications/cancelled" {
                let key = serde_json::to_string(&message["params"]["requestId"])?;
                if let Some(cancel) = pending.lock().unwrap().get(&key) { cancel.send_replace(true); }
                continue;
            }
            if method == "notifications/initialized" { continue; }
            let Some(id) = message.get("id").filter(|id| id.is_string() || id.is_number()).cloned() else { bail!("共享模式不支持此 MCP 通知"); };
            if method == "initialize" && !first_request {
                output.send(rpc_error(id, "MCP 连接不能重复初始化")).await?; continue;
            }
            first_request = false;
            if !["initialize", "tools/list", "tools/call", "ping"].contains(&method) {
                output.send(rpc_error(id, "共享模式仅支持 tools/list、tools/call 和 ping")).await?; continue;
            }
            if !host.registration(&pool.registration.registration_id).await.is_ok_and(|registration| registration.config == pool.registration.config && registration.max_instances == pool.registration.max_instances) {
                pool.stopped.store(true, Ordering::Release);
                pool.notify.notify_waiters();
                output.send(rpc_error(id, "MCP 共享配置已失效，请重新连接")).await?; continue;
            }
            let key = serde_json::to_string(&id)?;
            let (cancel, cancelled) = watch::channel(false);
            let admitted = {
                let mut requests = pending.lock().unwrap();
                if requests.contains_key(&key) || requests.len() >= QUEUE_LIMIT { false } else { requests.insert(key.clone(), cancel); true }
            };
            if !admitted { output.send(rpc_error(id, "MCP 请求标识重复或连接队列已满")).await?; continue; }
            let pool = pool.clone(); let output = output.clone(); let pending = pending.clone(); let shutdown = host.shutdown.subscribe();
            tokio::spawn(async move {
                let response = match pool.execute(message, output.clone(), cancelled, shutdown).await {
                    Ok(mut response) => { if response.get("jsonrpc").is_none() { response = json!({"jsonrpc":"2.0","result":response}); } response["id"] = id; response },
                    Err(error) => rpc_error(id, &error.to_string()),
                };
                let _ = output.send(response).await;
                pending.lock().unwrap().remove(&key);
            });
        }
        Ok::<_, anyhow::Error>(())
    }.await;
    for cancel in pending.lock().unwrap().values() {
        cancel.send_replace(true);
    }
    writer.abort();
    notifications.abort();
    outcome
}

pub fn run_relay_if_requested() -> Result<bool> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().is_none_or(|arg| arg != "--mcp-relay") {
        return Ok(false);
    }
    ensure!(args.len() == 5, "MCP 转发参数无效");
    let registration = args[1]
        .to_str()
        .ok_or_else(|| anyhow!("MCP 登记标识无效"))?
        .to_owned();
    let data_dir = PathBuf::from(&args[3]);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(relay(registration, data_dir));
    // Tokio stdin uses a blocking reader; shutdown must not wait for a detached caller.
    runtime.shutdown_background();
    result?;
    Ok(true)
}

async fn relay(registration: String, data_dir: PathBuf) -> Result<()> {
    let bytes = tokio::task::spawn_blocking(move || {
        crate::fs_util::read_bounded(&data_dir.join("mcp-scheduler.json"), 4096)
    })
    .await
    .map_err(|_| anyhow!("读取 MCP 发现文件任务异常退出"))?
    .map_err(|_| anyhow!("MCP 调度器未运行，请启动 CodeyX"))?;
    let discovery: Discovery =
        serde_json::from_slice(&bytes).map_err(|_| anyhow!("MCP 调度发现文件无效"))?;
    let address: std::net::SocketAddr = discovery
        .address
        .parse()
        .map_err(|_| anyhow!("MCP 调度地址无效"))?;
    ensure!(
        address.ip() == std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        "MCP 调度地址必须为回环地址"
    );
    let stream = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(address))
        .await?
        .map_err(|_| anyhow!("MCP 调度器连接失败，请启动 CodeyX"))?;
    stream.set_nodelay(true)?;
    let (read, mut write) = stream.into_split();
    let env: BTreeMap<String, String> = std::env::vars_os()
        .map(|(key, value)| {
            Ok((
                key.into_string()
                    .map_err(|_| anyhow!("MCP 环境变量名称不是有效文本，请保留直连"))?,
                value
                    .into_string()
                    .map_err(|_| anyhow!("MCP 环境变量值不是有效文本，请保留直连"))?,
            ))
        })
        .collect::<Result<_>>()?;
    io::write(&mut write, &json!({"token":discovery.token,"registration":registration,"cwd":std::env::current_dir()?,"env":env})).await?;
    let mut input = tokio::spawn(async move {
        let mut stdin = BufReader::new(tokio::io::stdin());
        while let Some(message) = io::read(&mut stdin).await? {
            io::write(&mut write, &message).await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let output = async {
        let mut read = BufReader::new(read);
        let mut stdout = tokio::io::stdout();
        while let Some(message) = io::read(&mut read).await? {
            io::write(&mut stdout, &message).await?;
        }
        Err::<(), _>(anyhow!("MCP 调度连接已关闭，请检查 CodeyX 与共享配置"))
    };
    tokio::select! { result = output => { input.abort(); result?; }, result = &mut input => { result??; } }
    Ok(())
}

fn private_discovery(path: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        crate::fs_util::atomic_write_private(path, bytes)
    }
    #[cfg(windows)]
    {
        use std::{
            io::Write,
            os::windows::{ffi::OsStrExt, io::FromRawHandle},
        };
        use windows::Win32::{
            Foundation::{GENERIC_WRITE, HLOCAL, LocalFree},
            Security::SECURITY_ATTRIBUTES,
            Storage::FileSystem::{
                CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE,
            },
        };
        #[link(name = "advapi32")]
        unsafe extern "system" {
            fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text: *const u16,
                revision: u32,
                descriptor: *mut *mut std::ffi::c_void,
                size: *mut u32,
            ) -> i32;
        }
        let temp = crate::fs_util::unique_temp_path(path);
        let text: Vec<u16> = "D:P(A;;FA;;;OW)\0".encode_utf16().collect();
        let mut descriptor = std::ptr::null_mut();
        unsafe {
            ensure!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    text.as_ptr(),
                    1,
                    &mut descriptor,
                    std::ptr::null_mut()
                ) != 0,
                "无法设置 MCP 发现文件权限"
            );
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: false.into(),
            };
            let name: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
            let handle = CreateFileW(
                windows::core::PCWSTR(name.as_ptr()),
                GENERIC_WRITE.0,
                FILE_SHARE_NONE,
                Some(&attributes),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                None,
            );
            let _ = LocalFree(HLOCAL(descriptor));
            let handle = handle.map_err(|_| anyhow!("无法创建私有 MCP 发现文件"))?;
            let result = (|| {
                let mut file = std::fs::File::from_raw_handle(handle.0);
                file.write_all(bytes)?;
                file.sync_all()
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&temp);
            }
            result?;
        }
        crate::fs_util::persist_temp_file(&temp, path)?;
        Ok(())
    }
}
