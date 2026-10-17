//! Launcher-side lifecycle; built without `capture` this has no WinDivert DLL
//! dependency. Only suspended, validated Codex roots may be assigned by callers.

use std::{
    os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result};
use tokio::{
    io::{AsyncWriteExt, WriteHalf},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::watch,
    task::JoinHandle,
};
use windows::{
    Win32::{
        Foundation::{ERROR_ALREADY_EXISTS, GetLastError, HANDLE, HLOCAL, LocalFree},
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
        },
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject,
            },
            Pipes::GetNamedPipeClientProcessId,
            Threading::GetProcessId,
        },
    },
    core::PCWSTR,
};

use crate::protocol::{self, Reply, Start};

struct PrivateSecurity(PSECURITY_DESCRIPTOR);

impl PrivateSecurity {
    fn new() -> Result<Self> {
        // Protected DACL: owning user, elevated administrators, LocalSystem.
        let sddl = "D:P(A;;GA;;;OW)(A;;GA;;;SY)(A;;GA;;;BA)"
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .context("创建代理控制通道权限失败")?;
        Ok(Self(descriptor))
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0.0,
            bInheritHandle: false.into(),
        }
    }
}

impl Drop for PrivateSecurity {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(HLOCAL(self.0.0));
        }
    }
}

struct Job {
    handle: OwnedHandle,
    ready: AtomicBool,
}
impl Job {
    fn handle(&self) -> HANDLE {
        HANDLE(self.handle.as_raw_handle())
    }
    fn stop(&self) {
        self.ready.store(false, Ordering::SeqCst);
        unsafe {
            let _ = TerminateJobObject(self.handle(), 1);
        }
    }
}

/// Dropping the session stops only this launch's job, before closing the pipe.
/// Children inherit job membership; no process-name scans or global app filters.
pub struct Session {
    id: uuid::Uuid,
    job: Arc<Job>,
    pipe: Option<NamedPipeServer>,
    writer: Option<WriteHalf<NamedPipeServer>>,
    monitor: Option<JoinHandle<()>>,
    stopped: Option<watch::Receiver<bool>>,
    service_pid: Option<u32>,
}

/// A launch may pass this binding to its Store activation supervisor. Retaining
/// it never retains readiness after the owning Session stops or disconnects.
#[derive(Clone)]
pub struct ProcessScope {
    job: Arc<Job>,
    service_pid: u32,
}

impl Session {
    pub fn new() -> Result<Self> {
        let id = uuid::Uuid::new_v4();
        let security = PrivateSecurity::new()?;
        let attributes = security.attributes();
        let name = protocol::job_name(id)
            .map_err(anyhow::Error::msg)?
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let handle = unsafe { CreateJobObjectW(Some(&attributes), PCWSTR(name.as_ptr())) }
            .context("创建 Codex 代理进程组失败")?;
        let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let job = Arc::new(Job {
            handle: unsafe { OwnedHandle::from_raw_handle(handle.0) },
            ready: AtomicBool::new(false),
        });
        anyhow::ensure!(!existed, "代理进程组标识冲突");
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        }
        .context("设置代理进程组退出保护失败")?;
        let pipe = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .max_instances(1)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    protocol::pipe_name(id).map_err(anyhow::Error::msg)?,
                    &attributes as *const _ as *mut _,
                )
        }
        .context("创建代理控制通道失败")?;
        Ok(Self {
            id,
            job,
            pipe: Some(pipe),
            writer: None,
            monitor: None,
            stopped: None,
            service_pid: None,
        })
    }

    pub fn id(&self) -> uuid::Uuid {
        self.id
    }

    /// The caller holds the launched service process handle throughout this
    /// handshake, so its PID cannot be reused by a different pipe client.
    pub async fn connect(&mut self, service: BorrowedHandle<'_>, config: Start) -> Result<()> {
        config.validate().map_err(anyhow::Error::msg)?;
        let expected_pid = unsafe { GetProcessId(HANDLE(service.as_raw_handle())) };
        anyhow::ensure!(
            expected_pid > 4 && expected_pid != std::process::id(),
            "代理服务进程无效"
        );
        let mut pipe = self.pipe.take().context("代理服务握手不能重复执行")?;
        tokio::time::timeout(Duration::from_secs(15), async {
            pipe.connect().await.context("代理服务未连接控制通道")?;
            let mut client_pid = 0;
            unsafe { GetNamedPipeClientProcessId(HANDLE(pipe.as_raw_handle()), &mut client_pid) }
                .context("无法核验代理服务进程")?;
            anyhow::ensure!(
                client_pid == expected_pid,
                "代理控制通道连接者不属于本次启动"
            );
            protocol::write_frame(&mut pipe, &config)
                .await
                .map_err(anyhow::Error::msg)?;
            let reply: Reply = protocol::read_frame(&mut pipe)
                .await
                .map_err(anyhow::Error::msg)?;
            anyhow::ensure!(
                reply
                    == Reply::Ready {
                        version: protocol::VERSION
                    },
                "代理捕获组件未就绪"
            );
            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("启动代理接管服务超时")??;
        let (mut reader, writer) = tokio::io::split(pipe);
        let (stopped_tx, stopped) = watch::channel(false);
        let job = self.job.clone();
        job.ready.store(true, Ordering::SeqCst);
        self.monitor = Some(tokio::spawn(async move {
            let _: Result<Reply, _> = protocol::read_frame(&mut reader).await;
            // A disconnected helper never causes the launcher to restart Codex
            // without capture. Crash-to-job-stop latency requires native testing.
            job.stop();
            let _ = stopped_tx.send(true);
        }));
        self.writer = Some(writer);
        self.stopped = Some(stopped);
        self.service_pid = Some(expected_pid);
        Ok(())
    }

    /// Call before resuming a newly-created root. Windows automatically includes
    /// descendants; the launcher must never permit JOB breakaway flags.
    pub fn assign_suspended(&self, process: BorrowedHandle<'_>) -> Result<()> {
        self.scope()?.assign_suspended(process)
    }

    pub fn scope(&self) -> Result<ProcessScope> {
        anyhow::ensure!(
            self.job.ready.load(Ordering::SeqCst),
            "代理服务尚未就绪或已经停止"
        );
        Ok(ProcessScope {
            job: self.job.clone(),
            service_pid: self.service_pid.context("代理服务尚未就绪")?,
        })
    }

    pub async fn wait_stopped(&mut self) -> Result<()> {
        let stopped = self.stopped.as_mut().context("代理服务尚未就绪")?;
        while !*stopped.borrow() {
            stopped.changed().await.context("代理状态通道已关闭")?;
        }
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
        self.job.stop();
        if let Some(writer) = &mut self.writer {
            let _ = writer.write_all(&[0]).await;
        }
        if self.stopped.is_some() {
            tokio::time::timeout(Duration::from_secs(15), self.wait_stopped())
                .await
                .context("停止代理接管服务超时")??;
        }
        Ok(())
    }
}

impl ProcessScope {
    /// The caller must hold a newly created, suspended and identity-validated
    /// process; running or unrelated processes must never be passed here.
    pub fn assign_suspended(&self, process: BorrowedHandle<'_>) -> Result<()> {
        let pid = unsafe { GetProcessId(HANDLE(process.as_raw_handle())) };
        anyhow::ensure!(
            pid > 4 && pid != std::process::id() && pid != self.service_pid,
            "不能将控制进程加入代理范围"
        );
        anyhow::ensure!(
            self.job.ready.load(Ordering::SeqCst),
            "代理服务尚未就绪或已经停止"
        );
        unsafe { AssignProcessToJobObject(self.job.handle(), HANDLE(process.as_raw_handle())) }
            .context("无法将 Codex 绑定到代理进程组，已停止本次启动")?;
        if !self.job.ready.load(Ordering::SeqCst) {
            // A monitor can stop an empty job between our first check and the
            // assignment. Stop again before returning, so this root never resumes.
            self.job.stop();
            anyhow::bail!("代理服务在绑定进程期间停止，已取消本次启动");
        }
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.job.stop();
        if let Some(monitor) = self.monitor.take() {
            monitor.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::{io::AsHandle, process::CommandExt};

    struct Fixture(std::process::Child);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn fixture(session: &Session, mode: &str, suspended: bool) -> Fixture {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "client::tests::fixture_service", "--ignored"])
            .env("CODEYX_TRAFFIC_FIXTURE_SESSION", session.id().to_string())
            .env("CODEYX_TRAFFIC_FIXTURE_MODE", mode)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let mut flags = windows::Win32::System::Threading::CREATE_NO_WINDOW.0;
        if suspended {
            flags |= windows::Win32::System::Threading::CREATE_SUSPENDED.0;
        }
        command.creation_flags(flags);
        Fixture(command.spawn().unwrap())
    }

    fn config() -> Start {
        Start {
            version: protocol::VERSION,
            gateway: "127.0.0.1:12345".parse().unwrap(),
            username: "fixture-user".into(),
            password: "fixture-password".into(),
        }
    }

    #[tokio::test]
    #[ignore = "subprocess fixture; spawned only by the tests below, never loads WinDivert"]
    async fn fixture_service() {
        let Ok(id) = std::env::var("CODEYX_TRAFFIC_FIXTURE_SESSION") else {
            return;
        };
        let id = uuid::Uuid::parse_str(&id).unwrap();
        let mut pipe = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(protocol::pipe_name(id).unwrap())
            .unwrap();
        let _: Start = protocol::read_frame(&mut pipe).await.unwrap();
        let version = if std::env::var("CODEYX_TRAFFIC_FIXTURE_MODE").unwrap() == "wrongVersion" {
            99
        } else {
            protocol::VERSION
        };
        protocol::write_frame(&mut pipe, &Reply::Ready { version })
            .await
            .unwrap();
        use tokio::io::AsyncReadExt;
        let mut stop = [0; 1];
        let _ = pipe.read(&mut stop).await;
        let _ = protocol::write_frame(&mut pipe, &Reply::Stopped).await;
    }

    #[tokio::test]
    async fn mock_service_handshake_binds_only_new_children_and_stops_the_job() {
        let mut session = Session::new().unwrap();
        let service = fixture(&session, "normal", false);
        let child = fixture(&session, "normal", true);
        assert!(session.assign_suspended(child.0.as_handle()).is_err());
        session
            .connect(service.0.as_handle(), config())
            .await
            .unwrap();
        assert!(session.assign_suspended(service.0.as_handle()).is_err());
        session.assign_suspended(child.0.as_handle()).unwrap();
        let mut belongs = windows::Win32::Foundation::BOOL(0);
        unsafe {
            windows::Win32::System::JobObjects::IsProcessInJob(
                HANDLE(child.0.as_raw_handle()),
                session.job.handle(),
                &mut belongs,
            )
        }
        .unwrap();
        assert!(belongs.as_bool());
        let retained = session.scope().unwrap();
        session.stop().await.unwrap();
        assert!(!session.job.ready.load(Ordering::SeqCst));
        assert!(session.assign_suspended(child.0.as_handle()).is_err());
        let later = fixture(&session, "normal", true);
        assert!(retained.assign_suspended(later.0.as_handle()).is_err());
    }

    #[tokio::test]
    async fn helper_exit_cancels_readiness_without_starting_capture_or_restarting_children() {
        let mut session = Session::new().unwrap();
        let mut service = fixture(&session, "normal", false);
        session
            .connect(service.0.as_handle(), config())
            .await
            .unwrap();
        service.0.kill().unwrap();
        service.0.wait().unwrap();
        tokio::time::timeout(Duration::from_secs(5), session.wait_stopped())
            .await
            .unwrap()
            .unwrap();
        assert!(!session.job.ready.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn stopping_one_session_preserves_the_other_sessions_children() {
        let mut first = Session::new().unwrap();
        let mut second = Session::new().unwrap();
        let first_service = fixture(&first, "normal", false);
        let second_service = fixture(&second, "normal", false);
        first
            .connect(first_service.0.as_handle(), config())
            .await
            .unwrap();
        second
            .connect(second_service.0.as_handle(), config())
            .await
            .unwrap();
        let mut first_child = fixture(&first, "normal", true);
        let mut second_child = fixture(&second, "normal", true);
        first.assign_suspended(first_child.0.as_handle()).unwrap();
        second.assign_suspended(second_child.0.as_handle()).unwrap();
        first.stop().await.unwrap();
        assert!(!first_child.0.wait().unwrap().success());
        assert!(second.job.ready.load(Ordering::SeqCst));
        assert!(second_child.0.try_wait().unwrap().is_none());
        second.stop().await.unwrap();
        assert!(!second_child.0.wait().unwrap().success());
    }

    #[tokio::test]
    async fn incompatible_helper_never_makes_the_session_ready() {
        let mut session = Session::new().unwrap();
        let service = fixture(&session, "wrongVersion", false);
        assert!(
            session
                .connect(service.0.as_handle(), config())
                .await
                .is_err()
        );
        assert!(!session.job.ready.load(Ordering::SeqCst));
        assert!(
            session
                .connect(service.0.as_handle(), config())
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn each_session_owns_a_distinct_private_job_and_rejects_the_controller() {
        let first = Session::new().unwrap();
        let second = Session::new().unwrap();
        assert_ne!(first.id(), second.id());
        let process = unsafe {
            windows::Win32::System::Threading::OpenProcess(
                windows::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                std::process::id(),
            )
        }
        .unwrap();
        let process = unsafe { OwnedHandle::from_raw_handle(process.0) };
        use std::os::windows::io::AsHandle;
        assert!(first.assign_suspended(process.as_handle()).is_err());
    }
}
