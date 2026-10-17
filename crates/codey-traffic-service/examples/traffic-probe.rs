#[cfg(windows)]
#[tokio::main]
async fn main() {
    if let Err(error) = probe::run().await {
        eprintln!("traffic-probe: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("此验证程序仅支持 Windows");
    std::process::exit(1);
}

#[cfg(windows)]
mod probe {
    use anyhow::{Context, Result};
    use codey_traffic_service::{client::Session, protocol::Start};
    use std::{
        net::{SocketAddr, TcpStream},
        os::windows::{
            io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
            process::CommandExt,
        },
        path::Path,
        process::{Child, Command},
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use windows::{
        Win32::{
            Foundation::{HANDLE, WAIT_OBJECT_0},
            System::Threading::{
                CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, GetExitCodeProcess,
                PROCESS_INFORMATION, ResumeThread, STARTUPINFOW, TerminateProcess,
                WaitForSingleObject,
            },
        },
        core::{PCWSTR, PWSTR},
    };

    const TARGET: &str = "192.0.2.123:443";
    const MARKER: &[u8] = b"CodeyX opaque stream\0\xff\x16\x03\x03";

    pub(super) async fn run() -> Result<()> {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        if args.len() == 2 && args[0] == "--leaf" {
            return leaf(&args[1]);
        }
        if args.len() == 2 && args[0] == "--parent" {
            leaf(&args[1])?;
            let status = Command::new(std::env::current_exe()?)
                .args(["--leaf", &args[1]])
                .creation_flags(CREATE_NO_WINDOW.0)
                .status()?;
            anyhow::ensure!(status.success(), "后代进程未经过模拟代理");
            return Ok(());
        }
        anyhow::ensure!(
            args == ["--live"],
            "只有显式 --live 才会加载驱动；请先在普通终端运行 verify.ps1，实际接管验证使用独立测试环境的管理员终端"
        );
        let current = std::env::current_exe()?;
        let service_path = current
            .parent()
            .context("无法读取验证目录")?
            .join("codey-traffic-service.exe");
        anyhow::ensure!(service_path.is_file(), "未找到同目录的接管服务");
        let mut first = Instance::start(&service_path, b'1').await?;
        let second_start = Instance::start(&service_path, b'2').await;
        let mut second = match second_start {
            Ok(instance) => instance,
            Err(error) => {
                let _ = first.stop().await;
                return Err(error);
            }
        };
        let result = async {
            let a = Suspended::spawn(&current, "--parent 1")?;
            let b = Suspended::spawn(&current, "--parent 2")?;
            first.session.assign_suspended(a.process.as_handle())?;
            second.session.assign_suspended(b.process.as_handle())?;
            a.resume()?;
            b.resume()?;
            let (a, b) = tokio::try_join!(a.wait(), b.wait())?;
            anyhow::ensure!(a == 0 && b == 0, "并行根进程或后代未使用各自出口");
            first.expect_count(2).await?;
            second.expect_count(2).await?;
            let outside = Suspended::spawn(&current, "--leaf 1")?;
            outside.resume()?;
            anyhow::ensure!(outside.wait().await? != 0, "范围外进程被接管");
            first.expect_count(2).await?;
            second.expect_count(2).await?;
            first.stop().await?;
            let remaining = Suspended::spawn(&current, "--leaf 2")?;
            second
                .session
                .assign_suspended(remaining.process.as_handle())?;
            remaining.resume()?;
            anyhow::ensure!(
                remaining.wait().await? == 0,
                "停止第一个会话影响了另一个出口"
            );
            second.expect_count(3).await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        let first_stop = first.stop().await;
        let second_stop = second.stop().await;
        result?;
        first_stop?;
        second_stop?;
        println!(
            "{{\"nativeCaptureTest\":\"passed\",\"directChild\":true,\"descendant\":true,\"unrelatedProcessExcluded\":true,\"multipleInstances\":true,\"distinctExits\":true,\"independentStop\":true,\"normalStop\":true,\"crashLeakTest\":\"not-run\",\"dnsLeakTest\":\"not-run\"}}"
        );
        Ok(())
    }

    struct Instance {
        session: Session,
        service: Child,
        server: tokio::task::JoinHandle<Result<()>>,
        count: Arc<AtomicUsize>,
        stopped: bool,
    }

    impl Instance {
        async fn start(service_path: &Path, exit: u8) -> Result<Self> {
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let gateway = listener.local_addr()?;
            let count = Arc::new(AtomicUsize::new(0));
            let serving_count = count.clone();
            let password = uuid::Uuid::new_v4().simple().to_string();
            let secret = password.clone();
            let session = Session::new()?;
            let service = Command::new(service_path)
                .args([
                    "--session",
                    &session.id().to_string(),
                    "--controller",
                    &std::process::id().to_string(),
                ])
                .creation_flags(CREATE_NO_WINDOW.0)
                .spawn()
                .context("启动接管服务失败")?;
            let server = tokio::spawn(async move {
                loop {
                    let (socket, _) = listener.accept().await?;
                    mock_socks(socket, &secret, exit).await?;
                    serving_count.fetch_add(1, Ordering::SeqCst);
                }
                #[allow(unreachable_code)]
                Ok::<_, anyhow::Error>(())
            });
            let mut instance = Self {
                session,
                service,
                server,
                count,
                stopped: false,
            };
            let connected = instance
                .session
                .connect(
                    instance.service.as_handle(),
                    Start {
                        version: 1,
                        gateway,
                        username: "codeyx-probe".into(),
                        password,
                    },
                )
                .await;
            if let Err(error) = connected {
                let _ = instance.stop().await;
                return Err(error);
            }
            Ok(instance)
        }
        async fn expect_count(&self, expected: usize) -> Result<()> {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let count = self.count.load(Ordering::SeqCst);
                    anyhow::ensure!(count <= expected, "出口请求数量与本会话不符");
                    if count == expected {
                        return Ok(());
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .context("等待模拟出口处理完成超时")?
        }
        async fn stop(&mut self) -> Result<()> {
            if self.stopped {
                return Ok(());
            }
            let stop = self.session.stop().await;
            let exited = wait_service(&mut self.service).await;
            if exited.is_err() {
                let _ = self.service.kill();
                let _ = self.service.wait();
            }
            self.server.abort();
            self.stopped = true;
            stop?;
            anyhow::ensure!(exited? == 0, "接管服务未正常停止");
            Ok(())
        }
    }
    impl Drop for Instance {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    fn leaf(exit: &str) -> Result<()> {
        use std::io::{Read, Write};
        anyhow::ensure!(matches!(exit, "1" | "2"), "无效测试出口");
        let target: SocketAddr = TARGET.parse()?;
        let mut socket = TcpStream::connect_timeout(&target, Duration::from_secs(3))?;
        socket.set_read_timeout(Some(Duration::from_secs(3)))?;
        socket.set_write_timeout(Some(Duration::from_secs(3)))?;
        socket.write_all(MARKER)?;
        let mut echoed = vec![0; MARKER.len() + 1];
        socket.read_exact(&mut echoed)?;
        anyhow::ensure!(
            &echoed[..MARKER.len()] == MARKER && echoed[MARKER.len()] == exit.as_bytes()[0],
            "测试数据未经过指定出口"
        );
        Ok(())
    }

    async fn mock_socks(mut socket: tokio::net::TcpStream, secret: &str, exit: u8) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut greeting = [0; 3];
            socket.read_exact(&mut greeting).await?;
            anyhow::ensure!(greeting == [5, 1, 2], "模拟代理协商错误");
            socket.write_all(&[5, 2]).await?;
            let version = socket.read_u8().await?;
            let length = socket.read_u8().await?;
            let mut username = vec![0; length as usize];
            socket.read_exact(&mut username).await?;
            let length = socket.read_u8().await?;
            let mut password = vec![0; length as usize];
            socket.read_exact(&mut password).await?;
            anyhow::ensure!(
                version == 1 && username == b"codeyx-probe" && password == secret.as_bytes(),
                "模拟代理认证错误"
            );
            socket.write_all(&[1, 0]).await?;
            let mut request = [0; 10];
            socket.read_exact(&mut request).await?;
            anyhow::ensure!(
                request == [5, 1, 0, 1, 192, 0, 2, 123, 1, 187],
                "模拟代理目标错误"
            );
            socket.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 1]).await?;
            let mut bytes = vec![0; MARKER.len()];
            socket.read_exact(&mut bytes).await?;
            anyhow::ensure!(bytes == MARKER, "模拟代理数据错误");
            socket.write_all(&bytes).await?;
            socket.write_all(&[exit]).await?;
            socket.shutdown().await?;
            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("模拟代理超时")??;
        Ok(())
    }

    struct Suspended {
        process: OwnedHandle,
        thread: OwnedHandle,
    }
    impl Suspended {
        fn spawn(path: &Path, argument: &str) -> Result<Self> {
            use std::os::windows::ffi::OsStrExt;
            let image = path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            // The executable path is OS-provided and the only arguments are the
            // fixed switches above; no user command or credentials are inserted.
            let mut command = format!("\"{}\" {argument}", path.display())
                .encode_utf16()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let startup = STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOW>() as u32,
                ..Default::default()
            };
            let mut info = PROCESS_INFORMATION::default();
            unsafe {
                CreateProcessW(
                    PCWSTR(image.as_ptr()),
                    PWSTR(command.as_mut_ptr()),
                    None,
                    None,
                    false,
                    CREATE_NO_WINDOW | CREATE_SUSPENDED,
                    None,
                    None,
                    &startup,
                    &mut info,
                )
            }
            .context("启动测试子进程失败")?;
            Ok(Self {
                process: unsafe { OwnedHandle::from_raw_handle(info.hProcess.0) },
                thread: unsafe { OwnedHandle::from_raw_handle(info.hThread.0) },
            })
        }
        fn resume(&self) -> Result<()> {
            anyhow::ensure!(
                unsafe { ResumeThread(HANDLE(self.thread.as_raw_handle())) } == 1,
                "恢复测试子进程失败"
            );
            Ok(())
        }
        async fn wait(&self) -> Result<u32> {
            tokio::time::timeout(Duration::from_secs(10), async {
                while unsafe { WaitForSingleObject(HANDLE(self.process.as_raw_handle()), 0) }
                    != WAIT_OBJECT_0
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                let mut code = 0;
                unsafe { GetExitCodeProcess(HANDLE(self.process.as_raw_handle()), &mut code) }?;
                Ok::<_, anyhow::Error>(code)
            })
            .await
            .context("测试子进程超时")?
        }
    }
    impl Drop for Suspended {
        fn drop(&mut self) {
            unsafe {
                let _ = TerminateProcess(HANDLE(self.process.as_raw_handle()), 1);
            }
        }
    }

    async fn wait_service(service: &mut Child) -> Result<i32> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(status) = service.try_wait()? {
                    return Ok::<_, anyhow::Error>(status.code().unwrap_or(1));
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .context("代理服务停止超时")?
    }
}
