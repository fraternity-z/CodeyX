use anyhow::{Result, anyhow, ensure};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

pub(crate) struct Process {
    child: Child,
    pub input: Option<ChildStdin>,
    pub output: Option<BufReader<ChildStdout>>,
    #[cfg(unix)]
    group: i32,
    #[cfg(windows)]
    job: windows::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for Process {}

impl Process {
    #[cfg(test)]
    pub(super) fn id(&self) -> u32 {
        self.child.id().expect("test process has exited")
    }

    pub async fn spawn(config: &Value, cwd: &Path, env: &BTreeMap<String, String>) -> Result<Self> {
        let executable = config["command"]
            .as_str()
            .ok_or_else(|| anyhow!("MCP 缺少启动程序"))?;
        let mut command = Command::new(executable);
        if let Some(args) = config.get("args") {
            for arg in args
                .as_array()
                .ok_or_else(|| anyhow!("MCP args 必须为数组"))?
            {
                command.arg(
                    arg.as_str()
                        .ok_or_else(|| anyhow!("MCP args 必须为字符串"))?,
                );
            }
        }
        let cwd = config
            .get("cwd")
            .and_then(Value::as_str)
            .map(Path::new)
            .unwrap_or(cwd);
        ensure!(cwd.is_absolute() && cwd.is_dir(), "MCP 工作目录无效");
        command.env_clear().envs(env).current_dir(cwd);
        if let Some(extra) = config.get("env") {
            for (key, value) in extra
                .as_object()
                .ok_or_else(|| anyhow!("MCP env 必须为对象"))?
            {
                command.env(
                    key,
                    value
                        .as_str()
                        .ok_or_else(|| anyhow!("MCP env 必须为字符串"))?,
                );
            }
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(
            windows::Win32::System::Threading::CREATE_SUSPENDED.0
                | windows::Win32::System::Threading::CREATE_NO_WINDOW.0,
        );
        let mut child = command
            .spawn()
            .map_err(|_| anyhow!("MCP 启动失败，请检查程序、权限与工作目录"))?;
        #[cfg(windows)]
        let job = attach_job(&child)?;
        let input = child.stdin.take();
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| anyhow!("MCP 标准输出不可用"))?,
        );
        let process = Self {
            #[cfg(unix)]
            group: child.id().ok_or_else(|| anyhow!("MCP 进程标识不可用"))? as i32,
            #[cfg(windows)]
            job,
            child,
            input,
            output: Some(output),
        };
        #[cfg(windows)]
        resume_process(&process.child)?;
        Ok(process)
    }

    pub fn is_running(&mut self) -> bool {
        self.child.try_wait().is_ok_and(|status| status.is_none())
    }

    pub async fn close(&mut self) {
        if let Some(mut input) = self.input.take() {
            let _ = input.shutdown().await;
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
        self.kill_tree();
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
    }

    fn kill_tree(&mut self) {
        #[cfg(unix)]
        unsafe {
            if self.group != 0 {
                libc::kill(-self.group, libc::SIGKILL);
                self.group = 0;
            }
        }
        #[cfg(windows)]
        unsafe {
            if !self.job.is_invalid() {
                let _ = windows::Win32::Foundation::CloseHandle(self.job);
                self.job = windows::Win32::Foundation::HANDLE::default();
            }
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.kill_tree();
        let _ = self.child.start_kill();
    }
}

#[cfg(windows)]
fn attach_job(child: &Child) -> Result<windows::Win32::Foundation::HANDLE> {
    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::*,
    };
    unsafe {
        let job = CreateJobObjectW(None, None).map_err(|_| anyhow!("无法创建 MCP 进程隔离组"))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let result = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        )
        .and_then(|_| {
            AssignProcessToJobObject(
                job,
                HANDLE(child.raw_handle().unwrap_or(std::ptr::null_mut())),
            )
        });
        if result.is_err() {
            let _ = CloseHandle(job);
            return Err(anyhow!("无法隔离 MCP 进程，已取消启动"));
        }
        Ok(job)
    }
}

#[cfg(windows)]
fn resume_process(child: &Child) -> Result<()> {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::{Diagnostics::ToolHelp::*, Threading::*},
    };
    let pid = child.id().ok_or_else(|| anyhow!("无法读取 MCP 进程标识"))?;
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
            .map_err(|_| anyhow!("无法读取暂停的 MCP 线程"))?;
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut next = Thread32First(snapshot, &mut entry).is_ok();
        let mut thread_id = None;
        while next {
            if entry.th32OwnerProcessID == pid {
                thread_id = Some(entry.th32ThreadID);
                break;
            }
            next = Thread32Next(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        let thread = OpenThread(
            THREAD_SUSPEND_RESUME,
            false,
            thread_id.ok_or_else(|| anyhow!("无法找到暂停的 MCP 线程"))?,
        )
        .map_err(|_| anyhow!("无法打开暂停的 MCP 线程"))?;
        let resumed = ResumeThread(thread);
        let _ = CloseHandle(thread);
        ensure!(resumed != u32::MAX, "无法恢复 MCP 进程");
    }
    Ok(())
}
