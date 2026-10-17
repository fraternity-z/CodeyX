use std::os::windows::io::{FromRawHandle, OwnedHandle};

use anyhow::{Context, Result};
use windows::{
    Win32::{
        Foundation::{ERROR_ALREADY_EXISTS, GetLastError},
        System::Threading::CreateMutexW,
    },
    core::PCWSTR,
};

const CAPACITY: i16 = 16;
const HIGHEST: i16 = 24000;

/// WinDivert reinjects only into lower priorities. Every active capture needs a
/// distinct priority, held until its last native handle has actually closed.
pub(super) struct Priority {
    pub(super) value: i16,
    _reservation: OwnedHandle,
}

impl Priority {
    pub(super) fn reserve() -> Result<Self> {
        Self::reserve_in(r"Global\CodeyXTrafficPriority-v1")
    }

    fn reserve_in(namespace: &str) -> Result<Self> {
        for slot in 0..CAPACITY {
            let name = format!("{namespace}-{slot}")
                .encode_utf16()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
                .context("无法分配代理捕获入口，请检查管理员权限")?;
            let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
            let reservation = unsafe { OwnedHandle::from_raw_handle(handle.0) };
            if !existed {
                return Ok(Self {
                    value: HIGHEST - slot,
                    _reservation: reservation,
                });
            }
        }
        anyhow::bail!("并行代理会话已达 16 个，请停止不再使用的会话后重试")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parallel_captures_reserve_distinct_slots_and_reuse_only_released_slots() {
        let namespace = format!(r"Local\CodeyXTrafficPriorityTest-{}", uuid::Uuid::new_v4());
        let mut leases = (0..CAPACITY)
            .map(|_| Priority::reserve_in(&namespace).unwrap())
            .collect::<Vec<_>>();
        let priorities = leases
            .iter()
            .map(|lease| lease.value)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(priorities.len(), CAPACITY as usize);
        assert!(Priority::reserve_in(&namespace).is_err());
        let released = leases.remove(5).value;
        let replacement = Priority::reserve_in(&namespace).unwrap();
        assert_eq!(replacement.value, released);
        assert!(Priority::reserve_in(&namespace).is_err());
    }
}
