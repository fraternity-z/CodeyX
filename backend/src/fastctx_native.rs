//! Desktop dynamic tools reuse the sidecar engine without an MCP transport.
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex as BlockingMutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt},
    process::ChildStdin,
    sync::{Mutex, Notify, Semaphore, TryAcquireError, oneshot},
};

// Only its process-tree/stdio lifecycle is shared with the MCP scheduler.
use crate::mcp_scheduler::process::Process;

const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAX_WORKERS: usize = 16;
const MAX_CALLS: usize = 4096;
const MAX_ACTIVE_CALLS: usize = 16;
const MAX_ADMITTED_CALLS: usize = 128;
const IDLE: Duration = Duration::from_secs(30);
const CALL_RETENTION: Duration = Duration::from_secs(600);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
type Response = Result<Value, String>;

#[derive(Clone, Default)]
pub(crate) struct Manager {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    workers: Mutex<HashMap<PathBuf, Arc<Worker>>>,
    calls: BlockingMutex<HashMap<String, Arc<Call>>>,
    reaper_started: AtomicBool,
}

struct Call {
    thread_id: String,
    worker: BlockingMutex<Weak<Worker>>,
    cancel_requested: AtomicBool,
    cancelled: Notify,
    dispatch: Mutex<()>,
    completed: BlockingMutex<Option<Instant>>,
    read_only: bool,
}

struct Worker {
    environment: BTreeMap<String, String>,
    process: Mutex<Process>,
    input: Mutex<ChildStdin>,
    pending: BlockingMutex<HashMap<String, oneshot::Sender<Response>>>,
    admitted: Semaphore,
    running: Semaphore,
    reader: BlockingMutex<Option<tokio::task::JoinHandle<()>>>,
    last_used: BlockingMutex<Instant>,
    stopped: AtomicBool,
}

struct PendingRequest<'a> {
    worker: &'a Worker,
    id: String,
    active: bool,
}

impl Drop for PendingRequest<'_> {
    fn drop(&mut self) {
        if self.active {
            self.worker.pending.lock().unwrap().remove(&self.id);
        }
    }
}

impl Manager {
    async fn worker(
        &self,
        executable: &Path,
        cwd: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Result<Arc<Worker>, String> {
        if !self.inner.reaper_started.swap(true, Ordering::AcqRel) {
            let weak = Arc::downgrade(&self.inner);
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(IDLE / 2).await;
                    let Some(inner) = weak.upgrade() else { break };
                    inner.release_idle().await;
                }
            });
        }
        let mut workers = self.inner.workers.lock().await;
        if let Some(worker) = workers.get(cwd)
            && !worker.stopped.load(Ordering::Acquire)
            && worker.environment == *environment
        {
            *worker.last_used.lock().unwrap() = Instant::now();
            return Ok(Arc::clone(worker));
        }
        workers.remove(cwd);
        if workers.len() >= MAX_WORKERS {
            return Err("FastCtx native 工作目录数量已达上限，请稍后重试".into());
        }
        let worker = Worker::start(executable, cwd, environment).await?;
        workers.insert(cwd.to_path_buf(), Arc::clone(&worker));
        Ok(worker)
    }

    pub(crate) async fn tools(
        &self,
        executable: &Path,
        cwd: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Response {
        let worker = self.worker(executable, cwd, environment).await?;
        tokio::time::timeout(
            Duration::from_secs(5),
            worker.request(
                format!("tools-{}", uuid::Uuid::new_v4()),
                "tools/list",
                json!({}),
            ),
        )
        .await
        .map_err(|_| "FastCtx native 工具清单读取超时".to_string())?
    }

    pub(crate) async fn call(
        &self,
        executable: &Path,
        cwd: &Path,
        environment: &BTreeMap<String, String>,
        request: CallRequest,
    ) -> Response {
        let record = self.reserve(
            &request.request_id,
            &request.thread_id,
            matches!(
                request.tool.as_str(),
                "inspect_local_file" | "grep" | "glob"
            ),
        )?;
        let worker = match self.worker(executable, cwd, environment).await {
            Ok(worker) => worker,
            Err(error) => {
                *record.completed.lock().unwrap() = Some(Instant::now());
                return Err(error);
            }
        };
        *record.worker.lock().unwrap() = Arc::downgrade(&worker);
        let (sender, response) = oneshot::channel();
        let cancellable = matches!(request.tool.as_str(), "grep" | "glob");
        let deadline = tokio::time::Instant::now() + CALL_TIMEOUT;
        tokio::spawn(async move {
            let result = async {
                if record.cancel_requested.load(Ordering::Acquire) {
                    return Err("FastCtx native 调用已在执行前取消".to_string());
                }
                let _admitted = worker.admitted.try_acquire().map_err(|error| match error {
                    TryAcquireError::Closed => "FastCtx native 连接已关闭；本次调用未重试",
                    TryAcquireError::NoPermits => "FastCtx native 调用等待队列已满，请稍后重试",
                }.to_string())?;
                let _running = tokio::time::timeout_at(deadline, async {
                    tokio::select! {
                        _ = record.cancelled.notified() => Err("FastCtx native 调用已在执行前取消".to_string()),
                        permit = worker.running.acquire() => permit.map_err(|_| "FastCtx native 连接已关闭；本次调用未重试".to_string()),
                    }
                }).await.map_err(|_| "FastCtx native 执行前等待超时；本次调用未执行".to_string())??;
                let execute = async {
                    let sent = {
                        // Cancellation and dispatch must agree before a queued write can leave the host.
                        let _dispatch = record.dispatch.lock().await;
                        if record.cancel_requested.load(Ordering::Acquire) {
                            return Err("FastCtx native 调用已在执行前取消".to_string());
                        }
                        if tokio::time::Instant::now() >= deadline {
                            return Err("FastCtx native 执行前等待超时；本次调用未执行".to_string());
                        }
                        worker.send(
                            request.request_id.clone(),
                            "tools/call",
                            json!({
                                "name":request.tool, "arguments":request.arguments,
                            }),
                        ).await
                    };
                    match sent {
                        Ok(result) => {
                            if record.cancel_requested.load(Ordering::Acquire) {
                                let _ = worker.cancel(&request.request_id).await;
                            }
                            receive(result).await
                        }
                        Err(error) => Err(error),
                    }
                };
                if cancellable {
                    match tokio::time::timeout_at(deadline, execute).await {
                        Ok(result) => result,
                        Err(_) => {
                            record.cancel_requested.store(true, Ordering::Release);
                            let _ = worker.cancel(&request.request_id).await;
                            worker.pending.lock().unwrap().remove(&request.request_id);
                            Err("FastCtx native 调用超时，执行结果尚未确认；本次调用未重试".into())
                        }
                    }
                } else {
                    // Once sent, inspect/replace retain ownership until their result arrives.
                    execute.await
                }
            }.await;
            *record.completed.lock().unwrap() = Some(Instant::now());
            let _ = sender.send(result);
        });
        if cancellable {
            return receive(response).await;
        }
        tokio::time::timeout(CALL_TIMEOUT, receive(response))
            .await
            .map_err(|_| "FastCtx native 调用超时，执行结果尚未确认；本次调用未重试".to_string())?
    }

    fn reserve(
        &self,
        request_id: &str,
        thread_id: &str,
        read_only: bool,
    ) -> Result<Arc<Call>, String> {
        let mut calls = self.inner.calls.lock().unwrap();
        if let Some(call) = calls.get(request_id) {
            let expired = call
                .completed
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|completed| completed.elapsed() >= CALL_RETENTION);
            if !expired {
                return Err("FastCtx native 调用标识已使用；本次调用未重试".into());
            }
            calls.remove(request_id);
        }
        if calls.len() >= MAX_CALLS {
            calls.retain(|_, call| {
                call.completed
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_none_or(|completed| completed.elapsed() < CALL_RETENTION)
            });
            if calls.len() >= MAX_CALLS {
                // Completed reads may be forgotten; running calls and retained writes cannot be replayed.
                let oldest_read = calls
                    .iter()
                    .filter(|(_, call)| call.read_only)
                    .filter_map(|(id, call)| {
                        call.completed
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|completed| (id, *completed))
                    })
                    .min_by_key(|(_, completed)| *completed)
                    .map(|(id, _)| id.clone());
                if let Some(id) = oldest_read {
                    calls.remove(&id);
                } else {
                    return Err("FastCtx native 调用记录已达上限，请稍后重试".into());
                }
            }
        }
        let call = Arc::new(Call {
            thread_id: thread_id.into(),
            worker: BlockingMutex::new(Weak::new()),
            cancel_requested: AtomicBool::new(false),
            cancelled: Notify::new(),
            dispatch: Mutex::new(()),
            completed: BlockingMutex::new(None),
            read_only,
        });
        calls.insert(request_id.into(), Arc::clone(&call));
        Ok(call)
    }

    pub(crate) async fn cancel(&self, request_id: &str, thread_id: &str) -> Response {
        let record = self.inner.calls.lock().unwrap().get(request_id).cloned();
        let Some(record) = record else {
            return Ok(json!({"requestId":request_id,"status":"notRunning"}));
        };
        if record.thread_id != thread_id {
            return Err("FastCtx native 调用不属于当前会话".into());
        }
        let _dispatch = record.dispatch.lock().await;
        if record.completed.lock().unwrap().is_some() {
            return Ok(json!({"requestId":request_id,"status":"notRunning"}));
        }
        record.cancel_requested.store(true, Ordering::Release);
        record.cancelled.notify_one();
        let worker = record.worker.lock().unwrap().upgrade();
        match worker {
            Some(worker) if worker.pending.lock().unwrap().contains_key(request_id) => {
                worker.cancel(request_id).await
            }
            _ => Ok(json!({"requestId":request_id,"status":"cancellationRequested"})),
        }
    }
}

pub(crate) struct CallRequest {
    pub request_id: String,
    pub thread_id: String,
    pub tool: String,
    pub arguments: Value,
}

impl Inner {
    async fn release_idle(&self) {
        let removed = {
            let mut workers = self.workers.lock().await;
            let idle: Vec<_> = workers
                .iter()
                .filter(|(_, worker)| {
                    worker.admitted.available_permits() == MAX_ADMITTED_CALLS
                        && worker.pending.lock().unwrap().is_empty()
                        && worker.last_used.lock().unwrap().elapsed() >= IDLE
                })
                .map(|(cwd, _)| cwd.clone())
                .collect();
            idle.into_iter()
                .filter_map(|cwd| workers.remove(&cwd))
                .collect::<Vec<_>>()
        };
        for worker in removed {
            worker.close().await;
        }
    }
}

impl Worker {
    async fn start(
        executable: &Path,
        cwd: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Result<Arc<Self>, String> {
        let config = json!({"command":executable,"args":["--codey-fastctx-native"]});
        Self::start_config(&config, cwd, environment).await
    }

    async fn start_config(
        config: &Value,
        cwd: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Result<Arc<Self>, String> {
        let mut process = Process::spawn(config, cwd, environment)
            .await
            .map_err(|_| "FastCtx native 启动失败，请检查程序、权限与工作目录".to_string())?;
        let input = process.input.take().ok_or("FastCtx native 输入不可用")?;
        let mut output = process.output.take().ok_or("FastCtx native 输出不可用")?;
        let worker = Arc::new(Self {
            environment: environment.clone(),
            process: Mutex::new(process),
            input: Mutex::new(input),
            pending: BlockingMutex::new(HashMap::new()),
            admitted: Semaphore::new(MAX_ADMITTED_CALLS),
            running: Semaphore::new(MAX_ACTIVE_CALLS),
            reader: BlockingMutex::new(None),
            last_used: BlockingMutex::new(Instant::now()),
            stopped: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&worker);
        let reader = tokio::spawn(async move {
            loop {
                let message = read_message(&mut output).await;
                let Some(worker) = weak.upgrade() else { break };
                match message {
                    Ok(Some(mut message)) => {
                        let Some(id) = message.get("id").and_then(Value::as_str) else {
                            worker.fail("FastCtx native 返回的调用标识无效");
                            worker.close().await;
                            break;
                        };
                        let pending = worker.pending.lock().unwrap().remove(id);
                        if let Some(pending) = pending {
                            *worker.last_used.lock().unwrap() = Instant::now();
                            let has_error = message.get("error").is_some();
                            let response = match message.get_mut("result") {
                                Some(result) if !has_error => Ok(result.take()),
                                _ => Err(message["error"]["message"]
                                    .as_str()
                                    .unwrap_or("FastCtx native 返回无效结果")
                                    .to_string()),
                            };
                            let _ = pending.send(response);
                        }
                    }
                    _ => {
                        worker.fail("FastCtx native 连接已关闭，执行结果尚未确认；本次调用未重试");
                        worker.close().await;
                        break;
                    }
                }
            }
        });
        *worker.reader.lock().unwrap() = Some(reader);
        Ok(worker)
    }

    async fn send(
        &self,
        id: String,
        method: &str,
        params: Value,
    ) -> Result<oneshot::Receiver<Response>, String> {
        if self.stopped.load(Ordering::Acquire) {
            return Err("FastCtx native 连接已关闭；本次调用未重试".into());
        }
        let mut bytes = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))
            .map_err(|_| "FastCtx native 请求无法编码".to_string())?;
        if bytes.len() >= MAX_FRAME {
            return Err("FastCtx native 请求超过 16 MiB 上限".into());
        }
        bytes.push(b'\n');
        let (sender, response) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if self.stopped.load(Ordering::Acquire) {
                return Err("FastCtx native 连接已关闭；本次调用未重试".into());
            }
            // Keep cancellation available when ordinary requests saturate the worker.
            let limit = if method == "cancel" { 64 } else { 32 };
            if pending.len() >= limit || pending.contains_key(&id) {
                return Err("FastCtx native 调用队列已满或标识重复".into());
            }
            pending.insert(id.clone(), sender);
        }
        let mut pending = PendingRequest {
            worker: self,
            id,
            active: true,
        };
        *self.last_used.lock().unwrap() = Instant::now();
        let sent = tokio::time::timeout(Duration::from_secs(10), async {
            let mut input = self.input.lock().await;
            input.write_all(&bytes).await?;
            input.flush().await
        })
        .await;
        if !matches!(sent, Ok(Ok(()))) {
            self.fail("FastCtx native 请求发送失败，执行结果尚未确认；本次调用未重试");
        }
        pending.active = false;
        Ok(response)
    }

    async fn request(&self, id: String, method: &str, params: Value) -> Response {
        let response = self.send(id.clone(), method, params).await?;
        let _pending = PendingRequest {
            worker: self,
            id,
            active: true,
        };
        receive(response).await
    }

    async fn cancel(&self, request_id: &str) -> Response {
        tokio::time::timeout(
            Duration::from_secs(5),
            self.request(
                format!("cancel-{}", uuid::Uuid::new_v4()),
                "cancel",
                json!({"requestId":request_id}),
            ),
        )
        .await
        .map_err(|_| "FastCtx native 取消请求超时，实际执行状态尚未确认".to_string())?
    }

    fn fail(&self, message: &str) {
        self.stopped.store(true, Ordering::Release);
        self.admitted.close();
        self.running.close();
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err(message.into()));
        }
    }

    async fn close(&self) {
        self.fail("FastCtx native 工作进程已回收");
        let _ = self.input.lock().await.shutdown().await;
        self.process.lock().await.close().await;
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let Some(reader) = self.reader.lock().unwrap().take() {
            reader.abort();
        }
    }
}

async fn receive(response: oneshot::Receiver<Response>) -> Response {
    response
        .await
        .map_err(|_| "FastCtx native 执行连接已关闭；本次调用未重试".to_string())?
}

async fn read_message(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<Value>, String> {
    let mut line = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|_| "FastCtx native 响应读取失败")?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err("FastCtx native 响应不完整".into())
            };
        }
        let size = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |index| index + 1);
        if line.len() + size > MAX_FRAME {
            return Err("FastCtx native 响应超过 16 MiB 上限".into());
        }
        let complete = buffer[size - 1] == b'\n';
        line.extend_from_slice(&buffer[..size]);
        reader.consume(size);
        if complete {
            return serde_json::from_slice(&line)
                .map(Some)
                .map_err(|_| "FastCtx native 响应 JSON 无效".into());
        }
    }
}

#[cfg(test)]
mod tests;
