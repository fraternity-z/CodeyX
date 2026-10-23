use super::*;

#[tokio::test]
async fn mcp_scheduler_discovery_recovers_stale_and_preserves_active_generation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let data = root.join("data");
    let home = root.join("codex");
    let first = start(home.clone(), data.clone(), root.clone())
        .await
        .unwrap();
    let path = data.join("mcp-scheduler.json");
    let original = std::fs::read(&path).unwrap();
    assert!(
        start(home.clone(), data.clone(), root.clone())
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
    drop(first); // Simulate a host exit without graceful discovery removal.
    let next = start(home.clone(), data.clone(), root.clone())
        .await
        .unwrap();
    assert_ne!(std::fs::read(&path).unwrap(), original);
    let newer = serde_json::to_vec(&Discovery {
        address: "127.0.0.1:1234".into(),
        token: uuid::Uuid::new_v4().to_string(),
    })
    .unwrap();
    std::fs::write(&path, &newer).unwrap();
    next.stop().await;
    assert_eq!(std::fs::read(&path).unwrap(), newer);
    drop(next);
    std::fs::write(&path, b"unrelated file").unwrap();
    let recovered = start(home.clone(), data.clone(), root.clone())
        .await
        .unwrap();
    assert!(serde_json::from_slice::<Discovery>(&std::fs::read(&path).unwrap()).is_ok());
    recovered.stop().await;
    drop(recovered);
    std::fs::create_dir(&path).unwrap();
    assert!(
        start(home.clone(), data.clone(), root.clone())
            .await
            .is_err()
    );
    std::fs::remove_dir(&path).unwrap();
    let lock = data.join("mcp-scheduler.lock");
    std::fs::remove_file(&lock).unwrap();
    std::fs::create_dir(&lock).unwrap();
    assert!(
        start(home.clone(), data.clone(), root.clone())
            .await
            .is_err()
    );
    std::fs::remove_dir(&lock).unwrap();
    let target = root.join("untouched");
    std::fs::write(&target, b"untouched").unwrap();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&target, &path);
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&target, &path);
    if linked.is_ok() {
        assert!(start(home, data, root).await.is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"untouched");
    }
}

async fn exchange(process: &mut process::Process, request: Value) -> Value {
    io::write(process.input.as_mut().unwrap(), &request)
        .await
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(15),
        io::read(process.output.as_mut().unwrap()),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap()
}

fn initialize() -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true}},"clientInfo":{"name":"real-relay-test","version":"1"}}})
}

fn request(params: Value) -> Value {
    json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":params})
}

fn running(pid: u32) -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0;
        let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == 259;
        let _ = CloseHandle(handle);
        alive
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
}

async fn assert_stopped(pids: &[u32]) {
    for _ in 0..40 {
        if pids.iter().all(|pid| !running(*pid)) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        pids.iter().all(|pid| !running(*pid)),
        "owned fixture process survived cleanup"
    );
}

#[cfg(windows)]
fn memory(pids: &[u32]) -> Value {
    use std::os::windows::process::CommandExt;
    let ids = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-Process -Id {ids} -ErrorAction Stop | ForEach-Object {{ [pscustomobject]@{{ pid=$_.Id; workingSet=$_.WorkingSet64; privateBytes=$_.PrivateMemorySize64 }} }}) | ConvertTo-Json -Compress"
    );
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(output.status.success(), "memory sampling failed");
    serde_json::from_slice(&output.stdout).unwrap()
}

#[cfg(not(windows))]
fn memory(_pids: &[u32]) -> Value {
    json!({"unavailable":"OS memory sampling is implemented for Windows only"})
}

#[tokio::test]
async fn mcp_scheduler_real_relay_e2e_and_resource_comparison() {
    let Some(executable) = std::env::var_os("CODEY_MCP_RELAY_EXECUTABLE") else {
        eprintln!("SKIP real relay: set CODEY_MCP_RELAY_EXECUTABLE to a built Codey binary");
        return;
    };
    let executable = PathBuf::from(executable);
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let home = root.join("codex");
    let data = root.join("data");
    let cwd = root.join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/src/mcp_scheduler/fixture.cjs");
    let backend = json!({"command":"node","args":[fixture]});
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    env.insert("CODEY_MCP_MARKER".into(), "real-relay-only".into());
    let host_pid = std::process::id();
    let direct_host_before = memory(&[host_pid]);
    let cold = std::time::Instant::now();
    let mut direct = Vec::new();
    let mut direct_pids = Vec::new();
    for _ in 0..4 {
        let mut child = process::Process::spawn(&backend, &cwd, &env).await.unwrap();
        assert!(
            exchange(&mut child, initialize())
                .await
                .get("result")
                .is_some()
        );
        direct_pids.push(
            exchange(&mut child, request(json!({}))).await["result"]["pid"]
                .as_u64()
                .unwrap() as u32,
        );
        direct.push(child);
    }
    let direct_cold_ms = cold.elapsed().as_secs_f64() * 1000.0;
    let warm = std::time::Instant::now();
    for child in &mut direct {
        io::write(child.input.as_mut().unwrap(), &request(json!({})))
            .await
            .unwrap();
    }
    for child in &mut direct {
        let response = tokio::time::timeout(
            Duration::from_secs(15),
            io::read(child.output.as_mut().unwrap()),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert!(response.get("result").is_some());
    }
    let direct_warm_ms = warm.elapsed().as_secs_f64() * 1000.0;
    let direct_memory = memory(&direct_pids);
    let direct_host_after = memory(&[host_pid]);
    for child in &mut direct {
        child.close().await;
    }
    assert_stopped(&direct_pids).await;
    std::fs::write(
        home.join("config.toml"),
        format!(
            "[mcp_servers.fixture]\ncommand='node'\nargs=['{}']\n",
            fixture.replace('\\', "/")
        ),
    )
    .unwrap();
    let service = ExtensionService::new(home.clone(), data.clone(), root.clone())
        .with_mcp_relay_executable(executable.clone());
    let inventory = service.dispatch(json!({"action":"list"})).unwrap();
    service.dispatch(json!({"action":"set_mcp_scheduler_enabled","enabled":true,"revision":inventory["revision"]})).unwrap();
    let inventory = service.dispatch(json!({"action":"list"})).unwrap();
    let result = service.dispatch(json!({"action":"set_mcp_sharing","id":"fixture","enabled":true,"confirmed":true,"maxInstances":1,"revision":inventory["revision"]})).unwrap();
    let registration = result["inventory"]["mcps"][0]["sharing"]["registrationId"]
        .as_str()
        .unwrap();
    let shared_host_before = memory(&[host_pid]);
    let cold = std::time::Instant::now();
    let scheduler = start(home.clone(), data.clone(), root.clone())
        .await
        .unwrap();
    let relay = json!({"command":executable,"args":["--mcp-relay",registration,home,data,root]});
    let mut relays = Vec::new();
    let mut backend_pid = None;
    let mut relay_pids = Vec::new();
    for _ in 0..4 {
        let mut child = process::Process::spawn(&relay, &cwd, &env).await.unwrap();
        relay_pids.push(child.id());
        assert!(
            exchange(&mut child, initialize())
                .await
                .get("result")
                .is_some()
        );
        let response = exchange(&mut child, request(json!({}))).await;
        assert_eq!(response["result"]["cwd"], json!(cwd));
        assert_eq!(response["result"]["marker"], "real-relay-only");
        assert_eq!(response["result"]["clientCapabilities"], json!({}));
        let pid = response["result"]["pid"].as_u64().unwrap() as u32;
        assert!(
            backend_pid
                .replace(pid)
                .is_none_or(|previous| previous == pid)
        );
        relays.push(child);
    }
    let shared_cold_ms = cold.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(scheduler.status()["pools"][0]["instances"], 1);
    let warm = std::time::Instant::now();
    // All four real clients use the same request ID concurrently.
    for child in &mut relays {
        io::write(child.input.as_mut().unwrap(), &request(json!({})))
            .await
            .unwrap();
    }
    for child in &mut relays {
        let response = tokio::time::timeout(
            Duration::from_secs(15),
            io::read(child.output.as_mut().unwrap()),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"]["pid"], backend_pid.unwrap());
    }
    let shared_warm_ms = warm.elapsed().as_secs_f64() * 1000.0;
    let shared_memory = memory(&[backend_pid.unwrap()]);
    let relay_memory = memory(&relay_pids);
    let shared_host_after = memory(&[host_pid]);
    relays[0].close().await;
    let response = exchange(&mut relays[1], request(json!({"spawnChild":true}))).await;
    assert_eq!(response["result"]["pid"], backend_pid.unwrap());
    let nested_pid = response["result"]["child"].as_u64().unwrap() as u32;
    scheduler.stop().await;
    for child in &mut relays {
        child.close().await;
    }
    let mut owned = relay_pids.clone();
    owned.extend([backend_pid.unwrap(), nested_pid]);
    assert_stopped(&owned).await;
    assert_eq!(scheduler.status()["pools"][0]["instances"], 0);
    let report = json!({"fixture":"local mock; four clients; sequential cold initialize+call; four warm calls", "hostPid":host_pid,"direct":{"ownedProcesses":4,"coldMs":direct_cold_ms,"warmFourCallsMs":direct_warm_ms,"backendMemory":direct_memory,"hostBefore":direct_host_before,"hostAfter":direct_host_after},"shared":{"ownedProcesses":5,"coldMs":shared_cold_ms,"warmFourCallsMs":shared_warm_ms,"backendMemory":shared_memory,"relayMemory":relay_memory,"hostBefore":shared_host_before,"hostAfter":shared_host_after},"limitations":"same test host baseline sampled separately; allocator retention/order affects incremental host RSS; no claim about real MCP workloads"});
    let output = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("output/mcp-scheduler-validation");
    std::fs::create_dir_all(&output).unwrap();
    std::fs::write(
        output.join("real-relay-measurement.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{}", serde_json::to_string(&report).unwrap());
}
