use std::{fs, future::pending};

use super::*;

const ENABLED: &str = "# keep\nmodel = \"test-model\"\n[desktop]\nrunCodexInWindowsSubsystemForLinux = true # keep choice\n[desktop.open-in-target-preferences]\n\"*\" = \"vscode\"\n[model_providers.test]\nbase_url = \"https://example.test/v1\"\n";

#[test]
fn wsl_selection_supports_tables_inline_tables_and_dotted_keys() {
    for original in [
        ENABLED,
        "desktop = { runCodexInWindowsSubsystemForLinux = true }\n",
        "desktop.runCodexInWindowsSubsystemForLinux = true\n",
    ] {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("config.toml"), original).unwrap();
        let preferences = Preferences::load(temp.path()).unwrap();
        assert!(preferences.enabled().unwrap());
        preferences.disable().unwrap();
        assert!(!Preferences::load(temp.path()).unwrap().enabled().unwrap());
    }
}

#[test]
fn wsl_recovery_changes_only_the_backend_choice_and_backs_up_original_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.toml");
    fs::write(&path, ENABLED).unwrap();
    Preferences::load(temp.path()).unwrap().disable().unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        ENABLED.replace(" = true #", " = false #")
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("config.toml.bak")).unwrap(),
        ENABLED
    );
}

#[test]
fn wsl_recovery_does_not_replace_a_change_made_while_the_prompt_is_open() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.toml");
    fs::write(&path, ENABLED).unwrap();
    let preferences = Preferences::load(temp.path()).unwrap();
    let newer = ENABLED.replace("test-model", "new-model");
    fs::write(&path, &newer).unwrap();
    assert!(preferences.disable().is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), newer);
    assert!(!temp.path().join("config.toml.bak").exists());
}

#[test]
fn wsl_selection_rejects_invalid_settings_without_rewriting_them() {
    for original in [
        "[desktop",
        "desktop = true\n",
        "[desktop]\nrunCodexInWindowsSubsystemForLinux = \"true\"\n",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        fs::write(&path, original).unwrap();
        assert!(
            Preferences::load(temp.path())
                .and_then(|preferences| preferences.enabled())
                .is_err()
        );
        assert_eq!(fs::read_to_string(path).unwrap(), original);
        assert!(!temp.path().join("config.toml.bak").exists());
    }
}

#[tokio::test]
async fn wsl_recovery_does_not_prompt_or_create_settings_when_wsl_is_not_enabled() {
    for original in [
        None,
        Some("model = \"test\"\n"),
        Some("[desktop]\nrunCodexInWindowsSubsystemForLinux = false\n"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        if let Some(original) = original {
            fs::write(&path, original).unwrap();
        }
        assert_eq!(recover(temp.path(), pending()).await.unwrap(), None);
        assert_eq!(fs::read_to_string(path).ok().as_deref(), original);
        assert!(!temp.path().join("config.toml.bak").exists());
    }
}

#[tokio::test]
async fn wsl_recovery_requires_explicit_confirmation() {
    for answer in [Ok(false), Err("dialog unavailable".to_owned()), Ok(true)] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        fs::write(&path, ENABLED).unwrap();
        let confirmed = answer == Ok(true);
        let expected = answer.clone().map(Some);
        assert_eq!(
            recover(temp.path(), async { answer })
                .await
                .map_err(|error| error.to_string()),
            expected
        );
        assert_eq!(
            Preferences::load(temp.path()).unwrap().enabled().unwrap(),
            !confirmed
        );
        assert_eq!(temp.path().join("config.toml.bak").exists(), confirmed);
    }
}
