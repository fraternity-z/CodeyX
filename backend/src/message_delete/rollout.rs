//! Bounded rollout staging and a self-contained streaming recovery journal.
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use super::{rollout_identity, rollout_recovery_path, same_rollout_metadata};

pub(super) const MAX_ROLLOUT_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_LINE_BYTES: u64 = 16 * 1024 * 1024;
const MAGIC: &[u8] = b"CODEY-ROLLOUT-2\n";
const DATA_OFFSET: u64 = 4096;
const BUFFER_BYTES: usize = 64 * 1024;

#[derive(Serialize, Deserialize)]
struct Header {
    version: u32,
    identity: String,
    original_len: u64,
    replacement_len: u64,
    original_hash: [u8; 32],
    replacement_hash: [u8; 32],
}

pub(super) fn check_size(metadata: &fs::Metadata) -> Result<()> {
    ensure!(metadata.is_file(), "会话记录不是普通文件");
    ensure!(
        metadata.len() <= MAX_ROLLOUT_BYTES,
        "会话记录超过 1 GiB 安全处理上限，已保留原文件"
    );
    Ok(())
}

fn check_space(length: u64, available: u64) -> Result<()> {
    // Original + replacement journal and one replacement staging file.
    ensure!(
        available >= length * 3 + DATA_OFFSET + 1024 * 1024,
        "磁盘可用空间不足，无法安全暂存会话及恢复记录，已保留原文件"
    );
    Ok(())
}

pub(super) fn for_each_line(path: &Path, mut visit: impl FnMut(&str) -> Result<()>) -> Result<()> {
    let file = File::open(path)?;
    check_size(&file.metadata()?)?;
    let mut reader = BufReader::with_capacity(BUFFER_BYTES, file);
    let mut line = Vec::new();
    let mut total = 0;
    loop {
        line.clear();
        let count = reader
            .by_ref()
            .take(MAX_LINE_BYTES + 1)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            return Ok(());
        }
        total += count as u64;
        ensure!(
            total <= MAX_ROLLOUT_BYTES,
            "会话记录超过 1 GiB 安全处理上限，已保留原文件"
        );
        ensure!(
            line.len() as u64 <= MAX_LINE_BYTES,
            "会话记录单行超过 16 MiB 安全处理上限，已保留原文件"
        );
        visit(std::str::from_utf8(&line).context("会话记录不是有效 UTF-8")?)?;
    }
}

pub(super) struct Prepared {
    journal: NamedTempFile,
    header: Header,
}

impl Prepared {
    pub fn new(
        destination: &Path,
        metadata: &fs::Metadata,
        write: impl FnOnce(&mut dyn Write, &mut dyn Write) -> Result<()>,
    ) -> Result<Self> {
        check_size(metadata)?;
        let parent = destination.parent().context("会话记录缺少目录")?;
        check_space(metadata.len(), fs2::available_space(parent)?)?;
        ensure!(
            !rollout_recovery_path(destination).exists(),
            "会话存在待恢复写入，请先恢复后再删除"
        );
        // NamedTempFile creates private, exclusive files and cleans up on every
        // pre-commit failure (including long lines and disk-full writes).
        let mut journal = BufWriter::with_capacity(BUFFER_BYTES, NamedTempFile::new_in(parent)?);
        let mut replacement =
            BufWriter::with_capacity(BUFFER_BYTES, NamedTempFile::new_in(parent)?);
        journal.write_all(&[0; DATA_OFFSET as usize])?;
        write(&mut journal, &mut replacement)?;
        let mut journal = journal.into_inner().map_err(|e| e.into_error())?;
        let mut replacement = replacement.into_inner().map_err(|e| e.into_error())?;
        let original_len = journal.as_file().metadata()?.len() - DATA_OFFSET;
        let replacement_len = replacement.as_file().metadata()?.len();
        ensure!(
            original_len == metadata.len(),
            "会话记录已变化，请重新加载后再删除"
        );
        ensure!(replacement_len <= original_len, "会话删除结果长度无效");
        replacement.seek(SeekFrom::Start(0))?;
        std::io::copy(&mut replacement, &mut journal)?;
        let header = Header {
            version: 2,
            identity: rollout_identity(metadata),
            original_len,
            replacement_len,
            original_hash: hash_range(journal.as_file_mut(), DATA_OFFSET, original_len)?,
            replacement_hash: hash_range(
                journal.as_file_mut(),
                DATA_OFFSET + original_len,
                replacement_len,
            )?,
        };
        let bytes = serde_json::to_vec(&header)?;
        ensure!(
            bytes.len() + MAGIC.len() + 5 <= DATA_OFFSET as usize,
            "会话恢复记录头过大"
        );
        journal.seek(SeekFrom::Start(0))?;
        journal.write_all(MAGIC)?;
        journal.write_all(&[0])?; // Durable restoring marker, separate from the immutable header.
        journal.write_all(&(bytes.len() as u32).to_le_bytes())?;
        journal.write_all(&bytes)?;
        journal.as_file().sync_all()?;
        Ok(Self { journal, header })
    }

    pub fn commit(mut self, destination: &Path, metadata: &fs::Metadata) -> Result<()> {
        let recovery_path = rollout_recovery_path(destination);
        let mut current = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(destination)?;
        current.try_lock_exclusive()?;
        ensure!(
            same_rollout_metadata(metadata, &current.metadata()?)
                && equal_range(
                    &mut current,
                    self.journal.as_file_mut(),
                    DATA_OFFSET,
                    self.header.original_len
                )?
                && same_rollout_metadata(metadata, &current.metadata()?)
                && same_rollout_metadata(metadata, &fs::symlink_metadata(destination)?),
            "会话记录已变化，请重新加载后再删除"
        );
        let mut journal = self
            .journal
            .persist_noclobber(&recovery_path)
            .map_err(|e| e.error)?;
        if let Err(error) = overwrite(
            &mut current,
            &mut journal,
            DATA_OFFSET + self.header.original_len,
            self.header.replacement_len,
        ) {
            drop(current);
            drop(journal);
            return match super::recover_rollout_write(destination) {
                Ok(()) => Err(error),
                Err(recovery_error) => Err(anyhow::anyhow!(
                    "会话写入失败：{error}；恢复失败：{recovery_error:#}；原始数据保存在 {}",
                    recovery_path.display()
                )),
            };
        }
        drop(journal);
        fs::remove_file(recovery_path)?;
        Ok(())
    }
}

fn hash_range(file: &mut File, offset: u64, mut length: u64) -> Result<[u8; 32]> {
    file.seek(SeekFrom::Start(offset))?;
    let mut hash = Sha256::new();
    let mut buffer = [0; BUFFER_BYTES];
    while length > 0 {
        let count = length.min(BUFFER_BYTES as u64) as usize;
        file.read_exact(&mut buffer[..count])?;
        hash.update(&buffer[..count]);
        length -= count as u64;
    }
    Ok(hash.finalize().into())
}

fn equal_range(
    current: &mut File,
    journal: &mut File,
    offset: u64,
    mut length: u64,
) -> Result<bool> {
    current.seek(SeekFrom::Start(0))?;
    journal.seek(SeekFrom::Start(offset))?;
    let (mut left, mut right) = ([0; BUFFER_BYTES], [0; BUFFER_BYTES]);
    while length > 0 {
        let count = length.min(BUFFER_BYTES as u64) as usize;
        current.read_exact(&mut left[..count])?;
        journal.read_exact(&mut right[..count])?;
        if left[..count] != right[..count] {
            return Ok(false);
        }
        length -= count as u64;
    }
    Ok(true)
}

fn overwrite(current: &mut File, journal: &mut File, offset: u64, length: u64) -> Result<()> {
    journal.seek(SeekFrom::Start(offset))?;
    current.seek(SeekFrom::Start(0))?;
    current.set_len(0)?;
    ensure!(
        std::io::copy(&mut journal.take(length), current)? == length,
        "会话恢复记录不完整"
    );
    current.sync_all()?;
    Ok(())
}

// Returns false for the legacy JSON format; the caller retains its v1 reader.
pub(super) fn recover(destination: &Path, mut journal: File) -> Result<bool> {
    let mut magic = [0; MAGIC.len()];
    match journal.read_exact(&mut magic) {
        Ok(()) if magic == MAGIC => {}
        Ok(()) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    let mut marker = [0];
    journal.read_exact(&mut marker)?;
    ensure!(marker[0] <= 1, "会话恢复状态无效，已保留恢复记录");
    let mut size = [0; 4];
    journal.read_exact(&mut size)?;
    let size = u32::from_le_bytes(size) as usize;
    ensure!(
        size <= DATA_OFFSET as usize - MAGIC.len() - 5,
        "会话恢复记录头无效"
    );
    let mut header = vec![0; size];
    journal.read_exact(&mut header)?;
    let header: Header = serde_json::from_slice(&header)?;
    ensure!(
        header.version == 2
            && header.original_len <= MAX_ROLLOUT_BYTES
            && header.replacement_len <= header.original_len,
        "会话恢复记录版本或长度无效"
    );
    ensure!(
        journal.metadata()?.len() == DATA_OFFSET + header.original_len + header.replacement_len
            && hash_range(&mut journal, DATA_OFFSET, header.original_len)? == header.original_hash
            && hash_range(
                &mut journal,
                DATA_OFFSET + header.original_len,
                header.replacement_len
            )? == header.replacement_hash,
        "会话恢复记录校验失败，已保留原文件及恢复记录"
    );
    let mut current = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(destination)?;
    current.try_lock_exclusive()?;
    ensure!(
        rollout_identity(&current.metadata()?) == header.identity
            && rollout_identity(&fs::symlink_metadata(destination)?) == header.identity,
        "会话文件身份已变化，保留恢复记录以供检查"
    );
    let length = current.metadata()?.len();
    if marker[0] == 1 {
        ensure!(
            equal_range(
                &mut current,
                &mut journal,
                DATA_OFFSET,
                length.min(header.original_len)
            )?,
            "会话恢复期间内容已变化，保留恢复记录以供检查"
        );
        if length < header.original_len {
            overwrite(&mut current, &mut journal, DATA_OFFSET, header.original_len)?;
        }
    } else if !(length == header.original_len
        && equal_range(&mut current, &mut journal, DATA_OFFSET, length)?)
    {
        ensure!(
            equal_range(
                &mut current,
                &mut journal,
                DATA_OFFSET + header.original_len,
                length.min(header.replacement_len)
            )?,
            "会话内容已变化，保留恢复记录以供检查"
        );
        if length < header.replacement_len {
            journal.seek(SeekFrom::Start(MAGIC.len() as u64))?;
            journal.write_all(&[1])?;
            journal.sync_all()?;
            overwrite(&mut current, &mut journal, DATA_OFFSET, header.original_len)?;
        }
    }
    drop(journal);
    fs::remove_file(rollout_recovery_path(destination))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staged(path: &Path, original: &[u8], replacement: &[u8]) -> Prepared {
        Prepared::new(path, &fs::metadata(path).unwrap(), |before, after| {
            before.write_all(original)?;
            after.write_all(replacement)?;
            Ok(())
        })
        .unwrap()
    }

    #[test]
    fn recovery_handles_every_interrupted_write_and_restore_prefix() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        let original = b"keep\nremove\n";
        let replacement = b"keep\n";
        for restoring in [false, true] {
            let contents = if restoring {
                original.as_slice()
            } else {
                replacement.as_slice()
            };
            for length in 0..=contents.len() {
                fs::write(&path, original).unwrap();
                let mut prepared = staged(&path, original, replacement);
                if restoring {
                    prepared
                        .journal
                        .seek(SeekFrom::Start(MAGIC.len() as u64))
                        .unwrap();
                    prepared.journal.write_all(&[1]).unwrap();
                }
                let recovery = rollout_recovery_path(&path);
                prepared.journal.persist(&recovery).unwrap();
                fs::write(&path, &contents[..length]).unwrap();
                super::super::recover_rollout_write(&path).unwrap();
                let expected = if !restoring && length == contents.len() {
                    replacement.as_slice()
                } else {
                    original.as_slice()
                };
                assert_eq!(fs::read(&path).unwrap(), expected);
                assert!(!recovery.exists());
            }
        }
    }

    #[test]
    fn recovery_preserves_completed_appends_and_rejects_external_changes_or_corruption() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        for (contents, accepted) in [
            (b"keep\nappended\n".as_slice(), true),
            (b"other\n".as_slice(), false),
        ] {
            fs::write(&path, b"keep\nremove\n").unwrap();
            let prepared = staged(&path, b"keep\nremove\n", b"keep\n");
            let recovery = rollout_recovery_path(&path);
            prepared.journal.persist(&recovery).unwrap();
            fs::write(&path, contents).unwrap();
            assert_eq!(super::super::recover_rollout_write(&path).is_ok(), accepted);
            assert_eq!(fs::read(&path).unwrap(), contents);
            if !accepted {
                fs::remove_file(recovery).unwrap();
            }
        }
        fs::write(&path, b"keep\nremove\n").unwrap();
        let mut prepared = staged(&path, b"keep\nremove\n", b"keep\n");
        prepared.journal.seek(SeekFrom::Start(DATA_OFFSET)).unwrap();
        prepared.journal.write_all(b"X").unwrap();
        prepared
            .journal
            .persist(rollout_recovery_path(&path))
            .unwrap();
        assert!(super::super::recover_rollout_write(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"keep\nremove\n");
    }

    #[test]
    fn boundaries_and_failed_staging_preserve_the_source_and_clean_temps() {
        assert!(check_space(10, 0).is_err());
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        fs::write(&path, b"keep\n").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        assert!(
            Prepared::new(&path, &metadata, |before, _| {
                before.write_all(b"keep\n")?;
                Err(std::io::Error::new(std::io::ErrorKind::StorageFull, "mock disk full").into())
            })
            .is_err()
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(0).unwrap();
        file.set_len(MAX_ROLLOUT_BYTES + 1).unwrap();
        assert!(for_each_line(&path, |_| panic!("oversized source must not be read")).is_err());
        file.set_len(MAX_LINE_BYTES + 1).unwrap();
        assert!(
            for_each_line(&path, |_| panic!("oversized line must not be processed"))
                .unwrap_err()
                .to_string()
                .contains("单行")
        );
    }

    #[test]
    fn staging_rejects_same_length_external_edits_and_changed_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        fs::write(&path, b"keep\nremove\n").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let prepared = staged(&path, b"keep\nremove\n", b"keep\n");
        fs::write(&path, b"keep\nchange\n").unwrap();
        assert!(prepared.commit(&path, &metadata).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"keep\nchange\n");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        let mut prepared = staged(&path, b"keep\nchange\n", b"keep\n");
        prepared.header.identity = "different-file".into();
        let bytes = serde_json::to_vec(&prepared.header).unwrap();
        prepared
            .journal
            .seek(SeekFrom::Start(MAGIC.len() as u64 + 1))
            .unwrap();
        prepared
            .journal
            .write_all(&(bytes.len() as u32).to_le_bytes())
            .unwrap();
        prepared.journal.write_all(&bytes).unwrap();
        prepared
            .journal
            .persist(rollout_recovery_path(&path))
            .unwrap();
        assert!(
            super::super::recover_rollout_write(&path)
                .unwrap_err()
                .to_string()
                .contains("身份")
        );
        assert_eq!(fs::read(&path).unwrap(), b"keep\nchange\n");
    }

    #[test]
    #[ignore = "large temporary I/O regression: 10/100/500 MiB"]
    fn large_rollout_streaming_regression() {
        for mib in [10, 100, 500] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("rollout.jsonl");
            let mut file = BufWriter::new(File::create(&path).unwrap());
            file.write_all(b"{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"keep\"}}\n")
                .unwrap();
            let line = format!(
                "{{\"type\":\"response_item\",\"payload\":{{\"output\":\"{}\"}}}}\n",
                "x".repeat(64 * 1024)
            );
            for _ in 0..mib * 16 {
                file.write_all(line.as_bytes()).unwrap();
            }
            file.flush().unwrap();
            let kept = file.get_ref().metadata().unwrap().len();
            file.write_all(b"{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"remove\"}}\n")
                .unwrap();
            file.flush().unwrap();
            drop(file);
            let identity = rollout_identity(&fs::metadata(&path).unwrap());
            let mut writer = fs::OpenOptions::new().append(true).open(&path).unwrap();
            let started = std::time::Instant::now();
            let found = super::super::delete_turns_from_rollout(
                directory.path(),
                &path,
                &std::collections::HashSet::from(["remove".into()]),
            )
            .unwrap();
            assert!(found.contains("remove"));
            assert_eq!(fs::metadata(&path).unwrap().len(), kept);
            assert_eq!(rollout_identity(&fs::metadata(&path).unwrap()), identity);
            writer.write_all(b"appended\n").unwrap();
            assert_eq!(fs::metadata(&path).unwrap().len(), kept + 9);
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
            println!(
                "{mib} MiB rollout: {:?}; original handle and bounded streaming verified",
                started.elapsed()
            );
        }
    }
}
