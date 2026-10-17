//! Windows launch adapter. Only an explicitly enabled launch opens this helper;
//! the ordinary application remains unelevated and never loads WinDivert itself.
use anyhow::{Context, Result};
use codey_traffic_service::{
    client::{ProcessScope, Session},
    protocol::{Start, VERSION},
};
use std::{
    os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    path::{Path, PathBuf},
};
use windows::{
    Win32::{
        Foundation::HANDLE,
        System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        },
    },
    core::PCWSTR,
};

use super::process_gateway::ProcessProxyAuth;

pub(crate) struct CaptureSession {
    session: Session,
    scope: ProcessScope,
    _process: OwnedHandle,
}

fn helper_path() -> Result<PathBuf> {
    let executable = std::env::current_exe().context("无法定位流量接管组件目录")?;
    Ok(executable
        .parent()
        .context("无法定位流量接管组件目录")?
        .join("codey-traffic-service.exe"))
}

pub(crate) fn available() -> bool {
    cfg!(target_arch = "x86_64") && helper_path().is_ok_and(|path| validate_bundle(&path).is_ok())
}

fn validate_bundle(path: &Path) -> Result<()> {
    anyhow::ensure!(
        path.is_absolute()
            && path
                .file_name()
                .is_some_and(|name| name == "codey-traffic-service.exe"),
        "流量接管组件路径无效"
    );
    for file in [
        path.to_path_buf(),
        path.with_file_name("WinDivert.dll"),
        path.with_file_name("WinDivert64.sys"),
    ] {
        anyhow::ensure!(
            file.is_file(),
            "缺少流量接管组件；请将验证包中的服务、WinDivert.dll 和 WinDivert64.sys 放到 CodeyX 程序目录后重试"
        );
    }
    Ok(())
}

impl CaptureSession {
    pub(crate) async fn start(auth: ProcessProxyAuth) -> Result<Self> {
        anyhow::ensure!(
            cfg!(target_arch = "x86_64"),
            "当前接管组件仅支持 Windows x64"
        );
        let path = helper_path()?;
        validate_bundle(&path)?;
        let mut session = Session::new()?;
        let id = session.id();
        let process = tokio::task::spawn_blocking(move || elevate_helper(&path, id))
            .await
            .context("启动流量接管服务的任务异常退出")??;
        session
            .connect(
                process.as_handle(),
                Start {
                    version: VERSION,
                    gateway: format!("{}:{}", auth.host, auth.port)
                        .parse()
                        .context("本机代理入口地址无效")?,
                    username: auth.username,
                    password: auth.password,
                },
            )
            .await
            .context("流量接管服务未就绪，已停止 Codex 启动")?;
        let scope = session.scope()?;
        Ok(Self {
            session,
            scope,
            _process: process,
        })
    }

    pub(crate) fn scope(&self) -> ProcessScope {
        self.scope.clone()
    }
    pub(crate) async fn stop(&mut self) -> Result<()> {
        self.session.stop().await
    }
}

fn elevate_helper(path: &Path, id: uuid::Uuid) -> Result<OwnedHandle> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::{
        Shell::{SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW},
        WindowsAndMessaging::SW_HIDE,
    };
    let image = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let verb = "runas\0".encode_utf16().collect::<Vec<_>>();
    // No addresses or credentials enter the elevated command line.
    let arguments = format!("--session {id} --controller {}\0", std::process::id())
        .encode_utf16()
        .collect::<Vec<_>>();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(image.as_ptr()),
        lpParameters: PCWSTR(arguments.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut info) }
        .context("流量接管需要管理员授权；授权取消或组件启动失败，Codex 未启动")?;
    anyhow::ensure!(
        !info.hProcess.is_invalid(),
        "未取得流量接管服务进程，已停止启动"
    );
    Ok(unsafe { OwnedHandle::from_raw_handle(info.hProcess.0) })
}

/// Store activation keeps a validated process handle alive while this runs.
pub(crate) fn bind_suspended_pid(scope: &ProcessScope, pid: u32) -> Result<()> {
    let process = unsafe {
        OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            pid,
        )
    }
    .context("无法打开待绑定的 Codex 进程")?;
    let process = unsafe { OwnedHandle::from_raw_handle(process.0) };
    scope.assign_suspended(process.as_handle())
}

/// Only call immediately after CREATE_SUSPENDED on a validated executable.
pub(crate) async fn bind_and_resume(
    scope: &ProcessScope,
    child: &mut tokio::process::Child,
) -> Result<()> {
    let result = (|| {
        let handle = child.raw_handle().context("Codex 启动进程句柄不可用")?;
        scope.assign_suspended(unsafe { BorrowedHandle::borrow_raw(handle) })?;
        resume_initial_thread(child.id().context("Codex 启动进程已经退出")?)
    })();
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}

fn resume_initial_thread(pid: u32) -> Result<()> {
    use windows::Win32::System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
        },
        Threading::{
            GetProcessIdOfThread, OpenThread, ResumeThread, THREAD_QUERY_LIMITED_INFORMATION,
            THREAD_SUSPEND_RESUME,
        },
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }?;
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.0) };
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut next = unsafe { Thread32First(HANDLE(snapshot.as_raw_handle()), &mut entry) }.is_ok();
    let mut threads = Vec::new();
    while next {
        if entry.th32OwnerProcessID == pid {
            threads.push(entry.th32ThreadID);
        }
        next = unsafe { Thread32Next(HANDLE(snapshot.as_raw_handle()), &mut entry) }.is_ok();
    }
    anyhow::ensure!(
        threads.len() == 1,
        "无法唯一确认 Codex 初始线程，已停止启动"
    );
    let thread = unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            false,
            threads[0],
        )
    }?;
    let thread = unsafe { OwnedHandle::from_raw_handle(thread.0) };
    let handle = HANDLE(thread.as_raw_handle());
    anyhow::ensure!(
        unsafe { GetProcessIdOfThread(handle) } == pid,
        "Codex 启动线程归属发生变化"
    );
    anyhow::ensure!(
        unsafe { ResumeThread(handle) } == 1,
        "恢复 Codex 启动线程失败"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_or_unexpected_bundles_fail_before_elevation() {
        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join("codey-traffic-service.exe");
        assert!(validate_bundle(&helper).is_err());
        for name in [
            "codey-traffic-service.exe",
            "WinDivert.dll",
            "WinDivert64.sys",
        ] {
            std::fs::write(dir.path().join(name), b"fixture").unwrap();
        }
        assert!(validate_bundle(&helper).is_ok());
        assert!(validate_bundle(&helper.with_file_name("other.exe")).is_err());
        assert!(validate_bundle(Path::new("codey-traffic-service.exe")).is_err());
    }

    #[tokio::test]
    #[ignore = "private subprocess fixture, never starts capture or requests elevation"]
    async fn fixture_control_helper() {
        use codey_traffic_service::protocol::{self, Reply};
        use tokio::io::AsyncReadExt;
        let Ok(id) = std::env::var("CODEYX_CAPTURE_TEST_SESSION") else {
            return;
        };
        let id = uuid::Uuid::parse_str(&id).unwrap();
        let mut pipe = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(protocol::pipe_name(id).unwrap())
            .unwrap();
        let _: Start = protocol::read_frame(&mut pipe).await.unwrap();
        protocol::write_frame(&mut pipe, &Reply::Ready { version: VERSION })
            .await
            .unwrap();
        let _ = pipe.read_u8().await;
        let _ = protocol::write_frame(&mut pipe, &Reply::Stopped).await;
    }

    #[tokio::test]
    async fn suspended_children_resume_only_with_a_live_capture_binding() {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        struct Helper(std::process::Child);
        impl Drop for Helper {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut session = Session::new().unwrap();
        let helper = Helper(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "network_proxy::process_capture::tests::fixture_control_helper",
                    "--ignored",
                ])
                .env("CODEYX_CAPTURE_TEST_SESSION", session.id().to_string())
                .creation_flags(CREATE_NO_WINDOW.0)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        session
            .connect(
                helper.0.as_handle(),
                Start {
                    version: VERSION,
                    gateway: "127.0.0.1:1".parse().unwrap(),
                    username: "fixture".into(),
                    password: "fixture-only".into(),
                },
            )
            .await
            .unwrap();
        let scope = session.scope().unwrap();
        let spawn = || {
            tokio::process::Command::new(std::env::current_exe().unwrap())
                .arg("--help")
                .creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap()
        };
        let mut child = spawn();
        assert!(child.try_wait().unwrap().is_none());
        bind_and_resume(&scope, &mut child).await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        session.stop().await.unwrap();
        let mut blocked = spawn();
        assert!(bind_and_resume(&scope, &mut blocked).await.is_err());
        assert!(blocked.try_wait().unwrap().is_some());
        assert!(resume_initial_thread(u32::MAX).is_err());
    }
}
