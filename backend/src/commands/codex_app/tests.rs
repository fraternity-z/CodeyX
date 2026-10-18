use super::*;
use crate::commands::{AppState, CodeyConfigSaveInput, save_codey_config_locked};
use crate::config::{CodeyConfig, ConfigStore};
use std::sync::Arc;
use tokio::sync::RwLock;

fn install(root: &Path) -> PathBuf {
    let app = root.join("versions/current");
    std::fs::create_dir_all(app.join("resources/app")).unwrap();
    std::fs::write(app.join("Codex.exe"), []).unwrap();
    std::fs::write(
        app.join("resources/app/package.json"),
        r#"{"name":"openai-codex-electron","version":"1.0.0"}"#,
    )
    .unwrap();
    app
}

#[test]
fn selected_directory_requires_a_recognized_complete_desktop_app() {
    let directory = tempfile::tempdir().unwrap();
    assert!(validate_codex_app_path("").is_err());
    assert!(validate_codex_app_path(" ").is_err());
    assert!(validate_codex_app_path(directory.path().to_str().unwrap()).is_err());
    let app = install(directory.path());
    assert_eq!(
        validate_codex_app_path(directory.path().to_str().unwrap()).unwrap(),
        app
    );
    for metadata in [
        r#"{"name":"other-app","version":"1.0.0"}"#,
        r#"{"name":"codex"}"#,
        "invalid json",
    ] {
        std::fs::write(app.join("resources/app/package.json"), metadata).unwrap();
        assert!(validate_codex_app_path(app.to_str().unwrap()).is_err());
    }
}

#[tokio::test]
async fn failed_directory_save_preserves_previous_config_in_memory_and_on_disk() {
    let directory = tempfile::tempdir().unwrap();
    let old = install(&directory.path().join("old"));
    let config = CodeyConfig {
        codex_app_path: old.to_string_lossy().into_owned(),
        ..Default::default()
    };
    let store = ConfigStore::new(directory.path().join("config.json"));
    store.save(&config).unwrap();
    let config = store.load().unwrap();
    let state = Arc::new(AppState {
        store,
        config: RwLock::new(config.clone()),
        ..Default::default()
    });
    let bytes = std::fs::read(state.store.path()).unwrap();
    let new = install(&directory.path().join("new"));
    assert!(validate_codex_app_path(new.to_str().unwrap()).is_ok());
    std::fs::remove_file(new.join("Codex.exe")).unwrap();
    let mut input = config.clone();
    input.codex_app_path = new.to_string_lossy().into_owned();
    input.slim_codex_pet = !input.slim_codex_pet;
    assert!(
        save_codey_config_locked(&state, CodeyConfigSaveInput::complete(input))
            .await
            .is_err()
    );
    assert_eq!(*state.config.read().await, config);
    assert_eq!(std::fs::read(state.store.path()).unwrap(), bytes);
    assert!(validate_codex_app_path(&state.config.read().await.codex_app_path).is_ok());
}

#[tokio::test]
async fn directory_save_normalizes_valid_path_and_keeps_memory_on_write_failure() {
    for fail_save in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("new");
        let app = install(&root);
        let config = CodeyConfig::default();
        let config_path = directory.path().join("config.json");
        if fail_save {
            std::fs::create_dir(&config_path).unwrap();
        }
        let state = Arc::new(AppState {
            store: ConfigStore::new(config_path),
            config: RwLock::new(config.clone()),
            ..Default::default()
        });
        let mut input = config.clone();
        input.codex_app_path = root.to_string_lossy().into_owned();
        let result = save_codey_config_locked(&state, CodeyConfigSaveInput::complete(input)).await;
        if fail_save {
            assert!(result.is_err());
            assert_eq!(*state.config.read().await, config);
        } else {
            assert!(result.is_ok());
            assert_eq!(
                state.config.read().await.codex_app_path,
                app.to_string_lossy()
            );
            assert_eq!(state.store.load().unwrap(), *state.config.read().await);
        }
    }
}
