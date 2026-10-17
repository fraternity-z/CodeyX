use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    time::Duration,
};

use anyhow::{Context, Result};
use windows::{
    Win32::{
        Foundation::HANDLE,
        System::{
            JobObjects::{
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
                JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList, OpenJobObjectW,
                QueryInformationJobObject, TerminateJobObject,
            },
            SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE},
        },
    },
    core::PCWSTR,
};

pub(super) struct Job(OwnedHandle);

impl Job {
    pub(super) fn open(name: &str) -> Result<Self> {
        let name = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let handle = unsafe {
            OpenJobObjectW(
                JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE,
                false,
                PCWSTR(name.as_ptr()),
            )
        }
        .context("未找到本次 Codex 启动的代理进程组")?;
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle.0) }))
    }

    pub(super) fn contains(&self, pid: u32) -> Result<bool> {
        if pid <= 4 || pid == std::process::id() {
            return Ok(false);
        }
        // Query our own job, rather than opening every process on the machine.
        // Protected antivirus/system processes are outside the job and need not
        // grant PROCESS_QUERY access for unrelated traffic to keep working.
        let mut capacity = 64;
        loop {
            let bytes = std::mem::size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()
                + (capacity - 1) * std::mem::size_of::<usize>();
            let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
            let info = storage
                .as_mut_ptr()
                .cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            let result = unsafe {
                QueryInformationJobObject(
                    self.handle(),
                    JobObjectBasicProcessIdList,
                    info.cast(),
                    bytes as u32,
                    None,
                )
            };
            match result {
                Ok(()) => {
                    let count = unsafe { (*info).NumberOfProcessIdsInList as usize };
                    anyhow::ensure!(count <= capacity, "代理进程组返回无效成员数量");
                    let ids = unsafe {
                        std::slice::from_raw_parts((*info).ProcessIdList.as_ptr(), count)
                    };
                    return Ok(ids.contains(&(pid as usize)));
                }
                Err(error)
                    if error.code() == windows::Win32::Foundation::ERROR_MORE_DATA.to_hresult()
                        && capacity < 65536 =>
                {
                    capacity *= 2
                }
                Err(error) => return Err(error).context("无法核验代理进程组成员"),
            }
        }
    }

    pub(super) fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }

    pub(super) fn empty(&self) -> Result<bool> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                self.handle(),
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of_val(&info) as u32,
                None,
            )
        }
        .context("无法确认 Codex 代理进程组状态")?;
        Ok(info.ActiveProcesses == 0)
    }

    /// Normal shutdown keeps capture handles open until managed clients are gone.
    pub(super) async fn stop_clients(&self) -> Result<()> {
        unsafe { TerminateJobObject(self.handle(), 1) }.context("无法停止代理进程组")?;
        tokio::time::timeout(Duration::from_secs(10), async {
            while !self.empty()? {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("等待代理进程组退出超时")??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unrelated_pids_do_not_require_opening_other_processes() {
        let session = crate::client::Session::new().unwrap();
        let job = Job::open(&crate::protocol::job_name(session.id()).unwrap()).unwrap();
        assert!(job.empty().unwrap());
        for pid in [0, 4, std::process::id(), u32::MAX] {
            assert!(!job.contains(pid).unwrap());
        }
    }

    #[tokio::test]
    async fn membership_is_read_from_the_owned_job_and_disappears_after_exit() {
        use std::os::windows::{io::AsRawHandle, process::CommandExt};
        use windows::Win32::System::{
            JobObjects::AssignProcessToJobObject,
            SystemServices::JOB_OBJECT_ASSIGN_PROCESS,
            Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED},
        };
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let session = crate::client::Session::new().unwrap();
        let name = crate::protocol::job_name(session.id()).unwrap();
        let job = Job::open(&name).unwrap();
        let name = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let assign =
            unsafe { OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, false, PCWSTR(name.as_ptr())) }
                .unwrap();
        let assign = unsafe { OwnedHandle::from_raw_handle(assign.0) };
        let child = Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .arg("--help")
                .creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0)
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id();
        assert!(!job.contains(pid).unwrap());
        unsafe {
            AssignProcessToJobObject(
                HANDLE(assign.as_raw_handle()),
                HANDLE(child.0.as_raw_handle()),
            )
        }
        .unwrap();
        assert!(job.contains(pid).unwrap());
        assert!(!job.empty().unwrap());
        drop(child);
        job.stop_clients().await.unwrap();
        assert!(job.empty().unwrap());
        assert!(!job.contains(pid).unwrap());
    }
}
