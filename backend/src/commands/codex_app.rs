use std::path::{Path, PathBuf};

use codey_runtime_core::app_paths::{normalize_codex_app_path, validate_codex_app_dir};

#[cfg(test)]
mod tests;

pub(super) fn validate_codex_app_path(path: &str) -> Result<PathBuf, String> {
    let selected = path.trim();
    if selected.is_empty() {
        return Err("请先选择 Codex 桌面应用所在目录".to_string());
    }
    let app_dir = normalize_codex_app_path(Path::new(selected))
        .ok_or_else(|| "所选目录不是可启动的 Codex 桌面应用，请选择 Codex 安装目录".to_string())?;
    validate_codex_app_dir(&app_dir)
        .map_err(|error| format!("无法识别所选 Codex 目录：{error:#}"))?;
    Ok(app_dir)
}

#[cfg(any(windows, target_os = "macos"))]
pub(super) async fn select_codex_app_directory() -> Result<Option<PathBuf>, String> {
    tokio::task::spawn_blocking(|| {
        let dialog = rfd::FileDialog::new().set_title("选择 Codex 桌面应用安装目录");
        #[cfg(target_os = "macos")]
        let selected = dialog.add_filter("Codex 应用", &["app"]).pick_file();
        #[cfg(windows)]
        let selected = dialog.pick_folder();
        selected
            .map(|path| validate_codex_app_path(&path.to_string_lossy()))
            .transpose()
    })
    .await
    .map_err(|error| format!("打开 Codex 目录选择器失败：{error}"))?
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(super) async fn select_codex_app_directory() -> Result<Option<PathBuf>, String> {
    Err("当前平台不支持选择 Codex 桌面应用目录".to_string())
}
