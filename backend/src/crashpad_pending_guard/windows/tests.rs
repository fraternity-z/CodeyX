use super::super::{CleanupMode, CleanupPolicy, cleanup, delete_group, inventory};
use super::*;

const IDS: [&str; 3] = [
    "12345678-1234-5678-9abc-def012345678",
    "00000000-0000-0000-0000-000000000002",
    "00000000-0000-0000-0000-000000000003",
];

fn metadata(states: &[u32]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for value in [0x4350_4144_u32, 1, states.len() as u32, 0] {
        bytes.extend(value.to_le_bytes());
    }
    let mut strings = Vec::new();
    for (index, state) in states.iter().enumerate() {
        let mut record = [0; RECORD_SIZE];
        record[..16].copy_from_slice(&Uuid::parse_str(IDS[index]).unwrap().to_bytes_le());
        record[16..20].copy_from_slice(&(strings.len() as u32).to_le_bytes());
        strings.extend(format!("{}.dmp\0", IDS[index]).as_bytes());
        record[20..24].copy_from_slice(&(strings.len() as u32).to_le_bytes());
        strings.push(0);
        record[44..48].copy_from_slice(&state.to_le_bytes());
        bytes.extend(record);
    }
    bytes.extend(strings);
    bytes
}

fn database(states: &[u32]) -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("reports")).unwrap();
    fs::write(temp.path().join("metadata"), metadata(states)).unwrap();
    for id in IDS.iter().take(states.len()) {
        fs::write(
            temp.path().join("reports").join(format!("{id}.dmp")),
            [1; 80],
        )
        .unwrap();
    }
    temp
}

fn policy() -> CleanupPolicy {
    CleanupPolicy {
        hard_limit_bytes: 100,
        target_bytes: 85,
        complete_report_quiet_period: Duration::ZERO,
        orphan_file_quiet_period: Duration::ZERO,
    }
}

#[test]
fn windows_paths_cover_desktop_and_nested_web_profiles() {
    let root = Path::new("C:/Users/test/AppData/Roaming");
    let paths = report_directories(root);
    assert_eq!(paths.len(), 3);
    assert!(paths.contains(&root.join("Codex/web/Codex/Crashpad/reports")));
    assert!(paths.iter().all(|path| path.starts_with(root)));
}

#[test]
fn parses_pending_records_and_rejects_invalid_layouts_and_paths() {
    let valid = metadata(&[0, 1, 2]);
    let parsed = parse_records(&valid, Path::new("metadata")).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].name, format!("{}.dmp", IDS[0]));
    for (offset, replacement) in [
        (0, 0),
        (4, 9),
        (8, u32::MAX),
        (HEADER_SIZE + 16, u32::MAX),
        (HEADER_SIZE + 44, 3),
    ] {
        let mut invalid = valid.clone();
        invalid[offset..offset + 4].copy_from_slice(&replacement.to_le_bytes());
        assert!(parse_records(&invalid, Path::new("metadata")).is_err());
    }
    for end in [1, 15, HEADER_SIZE + RECORD_SIZE - 1, valid.len() - 2] {
        assert!(parse_records(&valid[..end], Path::new("metadata")).is_err());
    }
    let mut invalid = metadata(&[0]);
    invalid[HEADER_SIZE + RECORD_SIZE..][..3].copy_from_slice(b"../");
    assert!(parse_records(&invalid, Path::new("metadata")).is_err());
    let mut mismatch = metadata(&[0]);
    mismatch[HEADER_SIZE] ^= 1;
    assert!(parse_records(&mismatch, Path::new("metadata")).is_err());
}

#[test]
fn empty_database_is_supported_without_creating_directories() {
    let temp = tempfile::tempdir().unwrap();
    let reports = temp.path().join("reports");
    assert_eq!(
        inventory(std::slice::from_ref(&reports)).directories_found,
        0
    );
    fs::write(temp.path().join("metadata"), []).unwrap();
    let result = inventory(std::slice::from_ref(&reports));
    assert_eq!(result.directories_found, 1);
    assert!(result.errors.is_empty());
    assert!(!reports.exists());
    fs::write(&reports, b"not a directory").unwrap();
    assert!(!inventory(&[reports]).errors.is_empty());
}

#[test]
fn cleanup_removes_only_pending_dumps_and_preserves_native_metadata() {
    let temp = database(&[0, 1, 2]);
    let reports = temp.path().join("reports");
    let unknown = reports.join("unknown.dmp");
    fs::write(&unknown, [2; 200]).unwrap();
    let before = fs::read(temp.path().join("metadata")).unwrap();
    let run = cleanup(
        std::slice::from_ref(&reports),
        CleanupMode::ClearStableReports,
        policy(),
        true,
    );
    assert!(run.cleanup.errors.is_empty(), "{:?}", run.cleanup.errors);
    assert_eq!(run.cleanup.reports_deleted, 1);
    assert_eq!(run.cleanup.bytes_reclaimed, 80);
    assert_eq!(run.snapshot.pending_bytes, 0);
    assert!(!reports.join(format!("{}.dmp", IDS[0])).exists());
    assert!(reports.join(format!("{}.dmp", IDS[1])).exists());
    assert!(reports.join(format!("{}.dmp", IDS[2])).exists());
    assert!(unknown.exists());
    assert_eq!(fs::read(temp.path().join("metadata")).unwrap(), before);
}

#[test]
fn limit_cleanup_keeps_the_low_watermark_and_skips_recent_reports() {
    let temp = database(&[0, 0]);
    let reports = temp.path().join("reports");
    let mut recent = policy();
    recent.complete_report_quiet_period = Duration::from_secs(600);
    let run = cleanup(
        std::slice::from_ref(&reports),
        CleanupMode::EnforceLimit,
        recent,
        true,
    );
    assert_eq!(run.cleanup.skipped_recent_reports, 2);
    assert_eq!(run.cleanup.files_deleted, 0);
    let run = cleanup(
        std::slice::from_ref(&reports),
        CleanupMode::EnforceLimit,
        policy(),
        true,
    );
    assert_eq!(run.cleanup.files_deleted, 1);
    assert_eq!(run.snapshot.pending_bytes, 80);
}

#[test]
fn active_uploader_and_changed_record_or_dump_are_preserved() {
    let temp = database(&[0]);
    let reports = temp.path().join("reports");
    let groups = inventory(std::slice::from_ref(&reports));
    let lock = lock_metadata(&temp.path().join("metadata")).unwrap();
    assert!(delete_group(&groups.reports[0]).is_err());
    drop(lock);
    fs::write(temp.path().join("metadata"), metadata(&[1])).unwrap();
    assert!(delete_group(&groups.reports[0]).is_err());
    fs::write(temp.path().join("metadata"), metadata(&[0])).unwrap();
    let dump = reports.join(format!("{}.dmp", IDS[0]));
    fs::write(&dump, [3; 90]).unwrap();
    assert!(delete_group(&groups.reports[0]).is_err());
    assert!(dump.exists());
}

#[test]
fn malformed_database_never_falls_back_to_unlocked_directory_cleanup() {
    let temp = database(&[0]);
    fs::write(temp.path().join("metadata"), b"unknown version").unwrap();
    let run = cleanup(
        &[temp.path().join("reports")],
        CleanupMode::ClearStableReports,
        policy(),
        true,
    );
    assert_eq!(run.cleanup.files_deleted, 0);
    assert!(!run.cleanup.errors.is_empty());
    assert!(
        temp.path()
            .join("reports")
            .join(format!("{}.dmp", IDS[0]))
            .exists()
    );
}

#[test]
fn a_recent_upload_attempt_keeps_an_old_dump() {
    let temp = database(&[0]);
    let dump = temp.path().join("reports").join(format!("{}.dmp", IDS[0]));
    let file = OpenOptions::new().write(true).open(&dump).unwrap();
    file.set_modified(UNIX_EPOCH + Duration::from_secs(1))
        .unwrap();
    let mut bytes = metadata(&[0]);
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    bytes[HEADER_SIZE + 32..HEADER_SIZE + 40].copy_from_slice(&now.to_le_bytes());
    fs::write(temp.path().join("metadata"), bytes).unwrap();
    let mut recent = policy();
    recent.complete_report_quiet_period = Duration::from_secs(600);
    let run = cleanup(
        &[temp.path().join("reports")],
        CleanupMode::ClearStableReports,
        recent,
        true,
    );
    assert_eq!(run.cleanup.skipped_recent_reports, 1);
    assert!(dump.exists());
}

#[cfg(unix)]
#[test]
fn symlinked_database_and_dumps_are_skipped() {
    use std::os::unix::fs::symlink;
    let temp = database(&[0]);
    let outside = tempfile::tempdir().unwrap();
    let reports = temp.path().join("reports");
    let dump = reports.join(format!("{}.dmp", IDS[0]));
    fs::remove_file(&dump).unwrap();
    let external = outside.path().join("keep.dmp");
    fs::write(&external, [7; 80]).unwrap();
    symlink(&external, &dump).unwrap();
    assert!(inventory(&[reports]).reports.is_empty());
    let linked = outside.path().join("database");
    symlink(temp.path(), &linked).unwrap();
    assert!(!inventory(&[linked.join("reports")]).errors.is_empty());
    assert!(external.exists());
}
