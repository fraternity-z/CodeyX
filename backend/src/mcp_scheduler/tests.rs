use super::*;

type TestReader = BufReader<tokio::net::tcp::OwnedReadHalf>;
type TestWriter = tokio::net::tcp::OwnedWriteHalf;

async fn connect(discovery: &Discovery, registration: &str) -> (TestReader, TestWriter) {
    let (read, mut write) = TcpStream::connect(&discovery.address)
        .await
        .unwrap()
        .into_split();
    io::write(&mut write, &json!({"token":discovery.token,"registration":registration,"cwd":std::env::current_dir().unwrap(),"env":std::env::vars().collect::<BTreeMap<_,_>>()})).await.unwrap();
    io::write(&mut write, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"sampling":{},"elicitation":{}},"clientInfo":{"name":"test","version":"1"}}})).await.unwrap();
    let mut read = BufReader::new(read);
    let response = io::read(&mut read).await.unwrap().unwrap();
    assert!(response.get("result").is_some(), "{response}");
    (read, write)
}

#[tokio::test]
async fn mcp_scheduler_connections_duplicate_ids_disconnect_and_reconcile() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let home = root.join("codex");
    let data = root.join("data");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(
        home.join("config.toml"),
        format!(
            "[mcp_servers.fixture]\ncommand='node'\nargs=['{}']\n",
            concat!(env!("CARGO_MANIFEST_DIR"), "/src/mcp_scheduler/fixture.cjs")
                .replace('\\', "/")
        ),
    )
    .unwrap();
    let service = ExtensionService::new(home.clone(), data.clone(), root.clone())
        .with_mcp_relay_executable(std::env::current_exe().unwrap());
    let inventory = service.dispatch(json!({"action":"list"})).unwrap();
    service.dispatch(json!({"action":"set_mcp_scheduler_enabled","enabled":true,"revision":inventory["revision"]})).unwrap();
    let inventory = service.dispatch(json!({"action":"list"})).unwrap();
    let result = service.dispatch(json!({"action":"set_mcp_sharing","id":"fixture","enabled":true,"confirmed":true,"maxInstances":2,"revision":inventory["revision"]})).unwrap();
    let registration = result["inventory"]["mcps"][0]["sharing"]["registrationId"]
        .as_str()
        .unwrap();
    let scheduler = start(home.clone(), data.clone(), root).await.unwrap();
    let discovery: Discovery =
        serde_json::from_slice(&std::fs::read(data.join("mcp-scheduler.json")).unwrap()).unwrap();
    let (mut first_read, mut first_write) = connect(&discovery, registration).await;
    let (mut second_read, mut second_write) = connect(&discovery, registration).await;
    assert_eq!(scheduler.status()["pools"].as_array().unwrap().len(), 1);
    assert_eq!(scheduler.status()["pools"][0]["instances"], 1);
    assert_eq!(scheduler.release_idle().await, 1);
    assert_eq!(scheduler.status()["pools"][0]["instances"], 0);
    let (_third_read, _third_write) = connect(&discovery, registration).await;
    assert_eq!(scheduler.status()["pools"][0]["instances"], 1);
    let inventory = service
        .inventory(&codey_codex_extensions::Scope::User)
        .unwrap();
    service.dispatch(json!({"action":"set_mcp_scheduler_enabled","enabled":false,"revision":inventory["revision"]})).unwrap();
    assert!(
        !std::fs::read_to_string(home.join("config.toml"))
            .unwrap()
            .contains("--mcp-relay")
    );
    scheduler.reconcile().await;
    assert_eq!(scheduler.status()["pools"][0]["instances"], 1);
    io::write(
        &mut first_write,
        &json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"delay":60000}}),
    )
    .await
    .unwrap();
    io::write(
        &mut first_write,
        &json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{}}),
    )
    .await
    .unwrap();
    assert!(
        io::read(&mut first_read)
            .await
            .unwrap()
            .unwrap()
            .get("error")
            .is_some()
    );
    io::write(
        &mut second_write,
        &json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{}}),
    )
    .await
    .unwrap();
    drop(first_read);
    drop(first_write);
    let response = tokio::time::timeout(Duration::from_secs(15), io::read(&mut second_read))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(response["id"], 7);
    assert!(response.get("result").is_some());
    assert_eq!(response["result"]["clientCapabilities"], json!({}));
    std::fs::write(
        home.join("config.toml"),
        "[mcp_servers.fixture]\ncommand='changed-externally'\n",
    )
    .unwrap();
    scheduler.reconcile().await;
    io::write(
        &mut second_write,
        &json!({"jsonrpc":"2.0","id":8,"method":"ping"}),
    )
    .await
    .unwrap();
    assert!(
        io::read(&mut second_read)
            .await
            .unwrap()
            .unwrap()
            .get("error")
            .is_some()
    );
    scheduler.stop().await;
    assert!(!data.join("mcp-scheduler.json").exists());
    assert!(
        scheduler.status()["pools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["running"] == 0)
    );
    assert!(
        scheduler.status()["pools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["instances"] == 0)
    );
}

fn pool(config: Value, max: usize) -> Arc<Pool> {
    Arc::new(Pool {
        registration: SharedMcpRegistration {
            registration_id: "fixture".into(),
            id: "fixture".into(),
            source_path: PathBuf::from("fixture.toml"),
            config,
            max_instances: max,
        },
        cwd: std::env::current_dir().unwrap(),
        env: std::env::vars().collect(),
        initialize: json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}),
        slots: Mutex::new(Vec::new()),
        queued: AtomicUsize::new(0),
        stopped: AtomicBool::new(false),
        notify: Notify::new(),
        error: Mutex::new(None),
        events: tokio::sync::broadcast::channel(32).0,
        admission: tokio::sync::Mutex::new(()),
    })
}

fn fixture(max: usize) -> Arc<Pool> {
    pool(
        json!({"command":"node","args":[concat!(env!("CARGO_MANIFEST_DIR"), "/src/mcp_scheduler/fixture.cjs")]}),
        max,
    )
}

async fn call(pool: &Pool, params: Value) -> Result<Value> {
    let (_cancel, cancelled) = watch::channel(false);
    let (_stop, stopped) = watch::channel(false);
    let (output, _responses) = mpsc::channel(32);
    pool.execute(
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":params}),
        output,
        cancelled,
        stopped,
    )
    .await
}

async fn close(pool: &Pool) {
    pool.stopped.store(true, Ordering::Release);
    pool.shrink(false).await;
}

#[tokio::test]
async fn mcp_scheduler_bounded_frames_reject_partial_and_oversize() {
    let mut partial = BufReader::new(&b"{\"jsonrpc\":\"2.0\"}"[..]);
    assert!(io::read(&mut partial).await.is_err());
    let bytes = vec![b'x'; io::MAX_FRAME + 1];
    assert!(
        io::read(&mut BufReader::new(bytes.as_slice()))
            .await
            .is_err()
    );
    assert_eq!(
        io::read(&mut BufReader::new(&b"{}\n"[..])).await.unwrap(),
        Some(json!({}))
    );
}

#[test]
fn mcp_scheduler_capabilities_reject_stateful_services() {
    assert_eq!(startup_timeout(&json!({})), Duration::from_secs(10));
    assert_eq!(
        startup_timeout(&json!({"startup_timeout_sec":60})),
        Duration::from_secs(60)
    );
    let base = json!({"protocolVersion":"2025-11-25","serverInfo":{},"capabilities":{"tools":{}}});
    assert!(validate_capabilities(&base).is_ok());
    for name in ["resources", "prompts", "tasks", "experimental"] {
        let mut value = base.clone();
        value["capabilities"][name] = json!({});
        assert!(validate_capabilities(&value).is_err());
    }
    assert!(validate_capabilities(&json!({"capabilities":{}})).is_err());
}

#[tokio::test(start_paused = true)]
async fn mcp_scheduler_expands_caps_and_returns_to_base() {
    let pool = pool(json!({}), 2);
    let started = Instant::now();
    let first = pool.acquire().await.unwrap();
    let second = pool.acquire().await.unwrap();
    assert_eq!(started.elapsed(), Duration::ZERO);
    assert_eq!(pool.slots.lock().unwrap().len(), 2);
    let third = pool.acquire();
    tokio::pin!(third);
    assert!(
        tokio::time::timeout(Duration::from_secs(1), &mut third)
            .await
            .is_err()
    );
    drop(second);
    tokio::time::advance(IDLE).await;
    pool.shrink(false).await;
    assert_eq!(pool.slots.lock().unwrap().len(), 1);
    drop(first);
    close(&pool).await;
    assert!(pool.slots.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn mcp_scheduler_servers_keep_last_idle_slot() {
    for (id, args) in [
        ("fixture", json!([])),
        ("codey_fastctx", json!([])),
        ("fixture", json!(["--codey-fastctx-mcp"])),
    ] {
        let mut pool = pool(json!({"args":args}), 1);
        Arc::get_mut(&mut pool).unwrap().registration.id = id.into();
        drop(pool.acquire().await.unwrap());
        tokio::time::advance(IDLE).await;
        assert_eq!(pool.shrink(false).await, 0, "{id}");
        assert_eq!(pool.slots.lock().unwrap().len(), 1);
        close(&pool).await;
    }
}

#[tokio::test(start_paused = true)]
async fn mcp_scheduler_fifo_survives_cancelled_waiter_and_prevents_barging() {
    let pool = pool(json!({}), 1);
    let running = pool.acquire().await.unwrap();
    let mut oldest = Box::pin(pool.acquire());
    let mut cancelled = Box::pin(pool.acquire());
    let mut newest = Box::pin(pool.acquire());
    assert!(futures_util::poll!(&mut oldest).is_pending());
    assert!(futures_util::poll!(&mut cancelled).is_pending());
    assert!(futures_util::poll!(&mut newest).is_pending());
    assert_eq!(pool.queued.load(Ordering::Acquire), 3);
    drop(cancelled);
    assert_eq!(pool.queued.load(Ordering::Acquire), 2);
    drop(running);
    assert!(futures_util::poll!(&mut newest).is_pending());
    let std::task::Poll::Ready(Ok(oldest)) = futures_util::poll!(&mut oldest) else {
        panic!("oldest caller did not receive the released slot");
    };
    assert!(futures_util::poll!(&mut newest).is_pending());
    drop(oldest);
    assert!(futures_util::poll!(&mut newest).is_ready());
    assert_eq!(pool.queued.load(Ordering::Acquire), 0);
}

#[tokio::test(start_paused = true)]
async fn mcp_scheduler_burst_expands_immediately_to_limit() {
    let pool = pool(json!({}), 8);
    let started = Instant::now();
    let mut reservations = Vec::new();
    for _ in 0..8 {
        reservations.push(pool.acquire().await.unwrap());
    }
    assert_eq!(started.elapsed(), Duration::ZERO);
    let mut overflow = Box::pin(pool.acquire());
    assert!(futures_util::poll!(&mut overflow).is_pending());
    assert_eq!(pool.slots.lock().unwrap().len(), 8);
    drop(reservations.pop());
    assert!(futures_util::poll!(&mut overflow).is_ready());
    assert_eq!(pool.slots.lock().unwrap().len(), 8);
}

#[tokio::test]
async fn mcp_scheduler_releases_idle_only_and_restarts_after_last_release() {
    let pool = fixture(2);
    let first = call(&pool, json!({})).await.unwrap();
    let busy = pool.acquire().await.unwrap();
    let second = call(&pool, json!({})).await.unwrap();
    assert_ne!(first["result"]["pid"], second["result"]["pid"]);
    assert_eq!(pool.shrink(true).await, 1);
    assert_eq!(pool.slots.lock().unwrap().len(), 1);
    assert!(busy.slot.is_live());
    drop(busy);
    assert_eq!(pool.shrink(true).await, 1);
    assert!(pool.slots.lock().unwrap().is_empty());
    let restarted = call(&pool, json!({})).await.unwrap();
    assert_ne!(first["result"]["pid"], restarted["result"]["pid"]);
    assert_ne!(second["result"]["pid"], restarted["result"]["pid"]);
    close(&pool).await;
}

#[tokio::test]
async fn mcp_scheduler_initialization_expands_without_blocking_behind_busy_calls() {
    let pool = fixture(2);
    let busy = pool.acquire().await.unwrap();
    let (_cancel, cancelled) = watch::channel(false);
    let (_stop, stopped) = watch::channel(false);
    let (output, _responses) = mpsc::channel(32);
    let initialized = tokio::time::timeout(
        Duration::from_secs(5),
        pool.execute(
            json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
            output,
            cancelled,
            stopped,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(initialized["capabilities"]["tools"].is_object());
    assert_eq!(pool.slots.lock().unwrap().len(), 2);
    drop(busy);
    close(&pool).await;
}

#[tokio::test(start_paused = true)]
async fn mcp_scheduler_queue_full_and_timeout_include_wait() {
    let pool = pool(json!({"tool_timeout_sec":0.01}), 1);
    let first = pool.acquire().await.unwrap();
    pool.queued.store(QUEUE_LIMIT, Ordering::Release);
    assert!(pool.acquire().await.is_err());
    assert_eq!(pool.queued.load(Ordering::Acquire), QUEUE_LIMIT);
    pool.queued.store(0, Ordering::Release);
    assert!(
        call(&pool, json!({}))
            .await
            .unwrap_err()
            .to_string()
            .contains("超时")
    );
    assert_eq!(pool.queued.load(Ordering::Acquire), 0);
    let mut after_timeout = Box::pin(pool.acquire());
    assert!(futures_util::poll!(&mut after_timeout).is_pending());
    drop(first);
    assert!(futures_util::poll!(&mut after_timeout).is_ready());
    assert_eq!(pool.queued.load(Ordering::Acquire), 0);
}

#[test]
fn mcp_scheduler_context_isolates_environment_cwd_and_initialize() {
    let pool = pool(json!({"command":"node"}), 4);
    let mut hello = Hello {
        token: "hidden".into(),
        registration: "fixture".into(),
        cwd: std::env::current_dir().unwrap(),
        env: BTreeMap::new(),
    };
    let first = pool_key(&pool.registration, &hello, &pool.initialize).unwrap();
    hello.env.insert("SECRET".into(), "value".into());
    assert_ne!(
        first,
        pool_key(&pool.registration, &hello, &pool.initialize).unwrap()
    );
    hello.env.clear();
    hello.cwd.push("different");
    assert_ne!(
        first,
        pool_key(&pool.registration, &hello, &pool.initialize).unwrap()
    );
    hello.cwd.pop();
    assert_ne!(
        first,
        pool_key(&pool.registration, &hello, &json!({})).unwrap()
    );
}

#[tokio::test]
async fn mcp_scheduler_fixture_reuses_process_and_ids_and_preserves_progress() {
    let pool = fixture(1);
    let first = call(&pool, json!({})).await.unwrap();
    let second = call(&pool, json!({})).await.unwrap();
    assert_eq!(first["result"]["pid"], second["result"]["pid"]);
    let (_cancel, cancelled) = watch::channel(false);
    let (_stop, stopped) = watch::channel(false);
    let (output, mut responses) = mpsc::channel(32);
    let response = pool.execute(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"progressToken":"client-token"}}}), output, cancelled, stopped).await.unwrap();
    assert!(response.get("id").is_none());
    assert_eq!(
        responses.recv().await.unwrap()["params"]["progressToken"],
        "client-token"
    );
    close(&pool).await;
}

#[tokio::test]
async fn mcp_scheduler_fixture_crash_callback_and_start_failure_do_not_replay() {
    let pool = fixture(1);
    let first = call(&pool, json!({})).await.unwrap();
    assert!(call(&pool, json!({"crash":true})).await.is_err());
    assert!(!pool.slots.lock().unwrap()[0].is_live());
    let second = call(&pool, json!({})).await.unwrap();
    assert_ne!(first["result"]["pid"], second["result"]["pid"]);
    assert!(call(&pool, json!({"callback":true})).await.is_err());
    close(&pool).await;
    let missing = super::tests::pool(
        json!({"command":"codey-nonexistent-mcp-fixture-program"}),
        1,
    );
    assert!(call(&missing, json!({})).await.is_err());
    assert!(!missing.slots.lock().unwrap()[0].is_live());
}

#[tokio::test]
async fn mcp_scheduler_fixture_cancel_isolates_other_client() {
    let pool = fixture(2);
    let (cancel, cancelled) = watch::channel(false);
    let (_stop, stopped) = watch::channel(false);
    let (output, _responses) = mpsc::channel(32);
    let task_pool = pool.clone();
    let task = tokio::spawn(async move {
        task_pool
            .execute(
                json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"delay":10000}}),
                output,
                cancelled,
                stopped,
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let other_pool = pool.clone();
    let other = tokio::spawn(async move { call(&other_pool, json!({})).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    cancel.send_replace(true);
    assert!(task.await.unwrap().is_err());
    assert!(other.await.unwrap().is_ok());
    close(&pool).await;
}

#[tokio::test]
async fn mcp_scheduler_mock_resource_comparison() {
    let start = std::time::Instant::now();
    let mut direct = Vec::new();
    let mut direct_rss = 0;
    for _ in 0..4 {
        let pool = fixture(1);
        direct_rss += call(&pool, json!({})).await.unwrap()["result"]["resident"]
            .as_u64()
            .unwrap();
        direct.push(pool);
    }
    let direct_time = start.elapsed();
    for pool in direct {
        close(&pool).await;
    }
    let pool = fixture(1);
    let start = std::time::Instant::now();
    let mut rss = 0;
    for _ in 0..4 {
        rss = call(&pool, json!({})).await.unwrap()["result"]["resident"]
            .as_u64()
            .unwrap();
    }
    println!(
        "mock only: direct backends=4 rss={direct_rss} elapsed={direct_time:?}; shared backends=1 rss={rss} elapsed={:?}; excludes relay/host memory",
        start.elapsed()
    );
    close(&pool).await;
}

#[tokio::test]
async fn mcp_scheduler_fixture_clears_host_environment_and_cleans_process_tree() {
    let mut pool = fixture(1);
    Arc::get_mut(&mut pool)
        .unwrap()
        .env
        .insert("CODEY_MCP_MARKER".into(), "relay-only".into());
    let result = call(&pool, json!({"spawnChild":true})).await.unwrap();
    assert_eq!(result["result"]["marker"], "relay-only");
    let child = result["result"]["child"].as_u64().unwrap() as u32;
    close(&pool).await;
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        for _ in 0..30 {
            let running = unsafe {
                match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, child) {
                    Ok(handle) => {
                        let mut code = 0;
                        let result = GetExitCodeProcess(handle, &mut code).is_ok() && code == 259;
                        let _ = CloseHandle(handle);
                        result
                    }
                    Err(_) => false,
                }
            };
            if !running {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("owned child survived scheduler cleanup");
    }
    #[cfg(unix)]
    {
        for _ in 0..30 {
            if unsafe { libc::kill(child as i32, 0) } != 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("owned child survived scheduler cleanup");
    }
}
