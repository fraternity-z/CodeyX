//! Windows Crashpad uses reports/*.dmp and a locked binary metadata table,
//! unlike the paired pending dump/sidecar files used on macOS.
use super::{
    FileIdentity, PendingFile, PendingFileKind, PendingInventory, ReportGroup, max_time, min_time,
};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};
use uuid::Uuid;

const HEADER_SIZE: usize = 16;
const RECORD_SIZE: usize = 56;
const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct PendingRecord {
    metadata: PathBuf,
    name: String,
    bytes: [u8; RECORD_SIZE],
}

pub(super) struct MetadataLock(File);

impl Drop for MetadataLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

fn ordinary(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !metadata.file_type().is_symlink()
}

fn checked_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|_| "无法检查 Windows Crashpad 路径".to_string())?;
        if !ordinary(&metadata) {
            return Err("Windows Crashpad 路径包含链接，已跳过".into());
        }
    }
    Ok(())
}

fn lock_metadata(path: &Path) -> Result<MetadataLock, String> {
    checked_path(path)?;
    if !fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file()) {
        return Err("Windows Crashpad metadata 不是普通文件".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| "无法打开 Windows Crashpad metadata".to_string())?;
    // fs2 uses LockFileEx over the full file on Windows, matching Crashpad.
    // Never wait for a busy uploader on the status/cleanup worker.
    fs2::FileExt::try_lock_exclusive(&file)
        .map_err(|_| "Windows Crashpad metadata 正忙，已跳过本次处理".to_string())?;
    Ok(MetadataLock(file))
}

fn read_records(lock: &mut MetadataLock, path: &Path) -> Result<Vec<PendingRecord>, String> {
    let mut bytes = Vec::new();
    (&mut lock.0)
        .take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取 Windows Crashpad metadata 失败".to_string())?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err("Windows Crashpad metadata 超出读取上限，已跳过".into());
    }
    parse_records(&bytes, path)
}

fn parse_records(bytes: &[u8], path: &Path) -> Result<Vec<PendingRecord>, String> {
    let invalid = || "Windows Crashpad metadata 格式不受支持，已跳过".to_string();
    // An initialized database can have an empty metadata file before its first report.
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if bytes.len() < HEADER_SIZE {
        return Err(invalid());
    }
    let u32_at =
        |slice: &[u8], offset| u32::from_le_bytes(slice[offset..offset + 4].try_into().unwrap());
    if u32_at(bytes, 0) != 0x4350_4144 || u32_at(bytes, 4) != 1 {
        return Err(invalid());
    }
    let count = u32_at(bytes, 8) as usize;
    let strings_start = count
        .checked_mul(RECORD_SIZE)
        .and_then(|size| size.checked_add(HEADER_SIZE))
        .ok_or_else(invalid)?;
    if strings_start > bytes.len() {
        return Err(invalid());
    }
    let strings = &bytes[strings_start..];
    let mut names = HashSet::new();
    let mut pending = Vec::new();
    for record in bytes[HEADER_SIZE..strings_start].chunks_exact(RECORD_SIZE) {
        let name_offset = u32_at(record, 16) as usize;
        let suffix = strings.get(name_offset..).ok_or_else(invalid)?;
        let end = suffix
            .iter()
            .position(|&value| value == 0)
            .ok_or_else(invalid)?;
        let name = std::str::from_utf8(&suffix[..end]).map_err(|_| invalid())?;
        let id = Uuid::from_bytes_le(record[..16].try_into().unwrap());
        // Basenames only, and tied to the record UUID; no arbitrary file paths.
        if name != format!("{id}.dmp") || !names.insert(name) {
            return Err(invalid());
        }
        let state = u32_at(record, 44);
        if record[48] & !3 != 0
            || i64::from_le_bytes(record[24..32].try_into().unwrap()) < 0
            || i64::from_le_bytes(record[32..40].try_into().unwrap()) < 0
        {
            return Err(invalid());
        }
        if state > 2 {
            return Err(invalid());
        }
        if state == 0 {
            pending.push(PendingRecord {
                metadata: path.to_path_buf(),
                name: name.to_string(),
                bytes: record.try_into().unwrap(),
            });
        }
    }
    Ok(pending)
}

pub(super) fn lock_pending_record(record: &PendingRecord) -> Result<MetadataLock, String> {
    let mut lock = lock_metadata(&record.metadata)?;
    if !read_records(&mut lock, &record.metadata)?
        .iter()
        .any(|current| current.name == record.name && current.bytes == record.bytes)
    {
        return Err("Windows Crashpad 报告状态已变化，已跳过清理".into());
    }
    // Revalidate the reports directory as well as metadata before deleting.
    checked_path(&record.metadata.parent().unwrap().join("reports"))?;
    Ok(lock)
}

pub(super) fn collect_reports(directory: &Path, inventory: &mut PendingInventory) {
    let Some(root) = directory.parent() else {
        return;
    };
    let metadata_path = root.join("metadata");
    match fs::symlink_metadata(&metadata_path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return,
        Err(_) => {
            inventory
                .errors
                .push("读取 Windows Crashpad metadata 状态失败".into());
            return;
        }
        Ok(_) => {}
    }
    let result = (|| {
        let mut lock = lock_metadata(&metadata_path)?;
        let records = read_records(&mut lock, &metadata_path)?;
        inventory.directories_found += 1;
        match fs::symlink_metadata(directory) {
            Ok(metadata) if ordinary(&metadata) && metadata.is_dir() => {}
            Ok(_) => return Err("Windows Crashpad reports 不是普通目录，已跳过".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("读取 Windows Crashpad reports 目录状态失败".into()),
        }
        checked_path(directory)?;
        for record in records {
            let path = directory.join(&record.name);
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) if ordinary(&metadata) && metadata.is_file() => metadata,
                Ok(_) => continue,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(_) => return Err("读取 Windows Crashpad 待处理报告失败".into()),
            };
            let modified = metadata.modified().ok();
            // Also respect a recent failed upload, even when the dump is old.
            let last_attempt = i64::from_le_bytes(record.bytes[32..40].try_into().unwrap());
            let attempted_at = if last_attempt > 0 {
                UNIX_EPOCH.checked_add(Duration::from_secs(last_attempt as u64))
            } else {
                None
            };
            let modified = max_time(modified, attempted_at);
            let length = metadata.len();
            inventory.files_found += 1;
            inventory.managed_files += 1;
            inventory.pending_bytes = inventory.pending_bytes.saturating_add(length);
            inventory.managed_bytes = inventory.managed_bytes.saturating_add(length);
            inventory.oldest = min_time(inventory.oldest, modified);
            inventory.newest = max_time(inventory.newest, modified);
            inventory.reports.push(ReportGroup {
                files: vec![PendingFile {
                    path,
                    name: record.name.clone(),
                    kind: PendingFileKind::Dump,
                    identity: FileIdentity::from_metadata(&metadata),
                }],
                complete: true,
                modified,
                windows_record: Some(record),
            });
        }
        Ok::<_, String>(())
    })();
    if let Err(error) = result {
        inventory.errors.push(error);
    }
    // Metadata is deliberately not rewritten. Crashpad's native CleanDatabase
    // prunes records for missing dumps, avoiding a second binary database writer.
}

#[cfg(any(windows, test))]
pub(super) fn report_directories(roaming: &Path) -> Vec<PathBuf> {
    [
        "Codex/Crashpad/reports",
        "Codex/web/Crashpad/reports",
        "Codex/web/Codex/Crashpad/reports",
    ]
    .into_iter()
    .map(|relative| roaming.join(relative))
    .collect()
}

#[cfg(test)]
mod tests;
