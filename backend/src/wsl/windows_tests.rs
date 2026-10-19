use super::*;

#[test]
fn interop_capture_is_directional_and_preserves_unrelated_environment() {
    let original = "KEEP/lp:WSL_INTEROP/p:WSL_DISTRO_NAME:USER/u:PWD/p:CODEX_SQLITE_HOME/w:";
    let merged = merge_wslenv(original, CONTEXT_ENV);
    assert_eq!(
        merged,
        "KEEP/lp:WSL_DISTRO_NAME/w:WSL_INTEROP/w:USER/w:PWD/w:CODEX_SQLITE_HOME/p"
    );
    assert_eq!(merge_wslenv(&merged, CONTEXT_ENV), merged);
    let launch = launch_environment();
    for name in ["WSL_DISTRO_NAME", "WSL_INTEROP"] {
        assert!(
            launch
                .iter()
                .any(|(key, value)| key == name && value.is_empty())
        );
    }
}

#[test]
fn native_windows_launches_do_not_select_wsl() {
    for empty in [None, Some(OsString::new())] {
        assert_eq!(
            InteropContext::from_values(
                empty.clone(),
                empty,
                Some("windows-user".into()),
                Some(r"E:\repo".into()),
            )
            .unwrap(),
            None
        );
    }
}

#[test]
fn interop_preserves_the_calling_distribution_user_and_linux_directory() {
    let context = InteropContext::from_values(
        Some("Other Ubuntu".into()),
        Some("/run/WSL/123_interop".into()),
        Some("root".into()),
        Some("/home/root/repo with 'quotes'".into()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(context.distro, "Other Ubuntu");
    assert_eq!(context.user.as_deref(), Some(std::ffi::OsStr::new("root")));
    assert_eq!(
        context.cwd.as_deref(),
        Some(std::ffi::OsStr::new("/home/root/repo with 'quotes'"))
    );
    // WSL 1 need not provide a WSL_INTEROP socket.
    assert!(
        InteropContext::from_values(Some("Ubuntu".into()), None, None, None)
            .unwrap()
            .is_some()
    );
}

#[test]
fn incomplete_interop_context_cannot_fall_back_to_windows() {
    assert!(
        InteropContext::from_values(None, Some("/run/WSL/123_interop".into()), None, None).is_err()
    );
    for cwd in ["relative", r"E:\repo"] {
        assert!(
            InteropContext::from_values(Some("Ubuntu".into()), None, None, Some(cwd.into()),)
                .is_err()
        );
    }
}

#[test]
fn linux_runtime_validation_rejects_missing_and_windows_binaries() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("codey");
    assert!(require_elf(&path, "runtime").is_err());
    std::fs::write(&path, b"MZ Windows executable").unwrap();
    assert!(require_elf(&path, "runtime").is_err());
    std::fs::write(&path, b"\x7fELF").unwrap();
    require_elf(&path, "runtime").unwrap();
}

#[test]
fn wsl_readiness_requires_the_native_backend_confirmation() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("ready.json");
    let mut child = Command::new("cmd.exe")
        .args(["/d", "/c", "exit", "/b", "0"])
        .creation_flags(codey_runtime_core::windows_create_no_window())
        .spawn()
        .unwrap();
    let error = wait_until_ready(&mut child, &marker).unwrap_err();
    assert!(error.to_string().contains("就绪前退出"));
    child.wait().unwrap();

    let mut failure = CliWrapperMarker::new(CliWrapperMarkerStatus::Failed);
    failure.message = Some("native validation failed".into());
    failure.write(&marker).unwrap();
    assert_eq!(
        wait_until_ready(&mut child, &marker)
            .unwrap_err()
            .to_string(),
        "native validation failed"
    );
    CliWrapperMarker::new(CliWrapperMarkerStatus::Executed)
        .write(&marker)
        .unwrap();
    wait_until_ready(&mut child, &marker).unwrap();
}
