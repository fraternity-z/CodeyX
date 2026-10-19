use std::{path::Path, sync::Arc};

use anyhow::{Context, Result};
use codey_runtime_core::config_manager::{ConfigManager, ConfigSnapshot};
use toml_edit::Item;

const WSL_SETTING: &str = "runCodexInWindowsSubsystemForLinux";

pub(super) struct Preferences {
    manager: ConfigManager,
    snapshot: Arc<ConfigSnapshot>,
}

impl Preferences {
    pub(super) fn load(home: &Path) -> Result<Self> {
        let manager = ConfigManager::for_home(home);
        let snapshot = manager.load().context("读取 Codex WSL 设置失败")?;
        Ok(Self { manager, snapshot })
    }

    pub(super) fn enabled(&self) -> Result<bool> {
        let Some(desktop) = self.snapshot.document().get("desktop") else {
            return Ok(false);
        };
        let desktop = desktop
            .as_table_like()
            .context("Codex desktop 设置必须是 TOML 表")?;
        match desktop.get(WSL_SETTING) {
            None => Ok(false),
            Some(value) => value.as_bool().context("Codex WSL 设置必须是布尔值"),
        }
    }

    fn disable(self) -> Result<()> {
        if !self.enabled()? {
            return Ok(());
        }
        self.manager.update(
            Some(self.snapshot.revision()),
            "disable WSL after confirmed startup recovery",
            "wsl_startup_recovery",
            |editor| {
                editor.edit_document(|document| {
                    let value = document
                        .get_mut("desktop")
                        .and_then(Item::as_table_like_mut)
                        .and_then(|desktop| desktop.get_mut(WSL_SETTING))
                        .and_then(Item::as_value_mut)
                        .context("Codex WSL 设置已不可用")?;
                    let mut disabled = toml_edit::Value::from(false);
                    *disabled.decor_mut() = value.decor().clone();
                    *value = disabled;
                    Ok(())
                })
            },
        )?;
        Ok(())
    }
}

pub(super) async fn recover(
    home: &Path,
    prompt: impl std::future::Future<Output = Result<bool, String>>,
) -> Result<Option<bool>> {
    let home = home.to_owned();
    let preferences = tokio::task::spawn_blocking(move || Preferences::load(&home))
        .await
        .context("读取 Codex WSL 设置的任务异常退出")??;
    if !preferences.enabled()? {
        return Ok(None);
    }
    if !prompt.await.map_err(anyhow::Error::msg)? {
        return Ok(Some(false));
    }
    tokio::task::spawn_blocking(move || preferences.disable())
        .await
        .context("保存 Codex WSL 设置的任务异常退出")??;
    Ok(Some(true))
}

#[cfg(test)]
#[path = "preferences_tests.rs"]
mod tests;
