use super::*;
use serde_json::json;

const WINDOWS_HOOKS: &str = r"C:\Users\test\.codex\hooks.json";
const WINDOWS_HOST: &str = r"C:\Program Files\Codey\Codey.exe";
const EVENT: &str = "pre_tool_use";

struct HookFixture {
    _directory: tempfile::TempDir,
    path: std::path::PathBuf,
    hooks: serde_json::Value,
    states: InlineTable,
}

impl HookFixture {
    fn new(argument: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hooks.json");
        let command =
            crate::subagent_gate::windows_posix_hook_command(Path::new(WINDOWS_HOST), argument);
        let windows_command = format!("& '{WINDOWS_HOST}' {argument}");
        let hooks = json!({"hooks": {"PreToolUse": [
            {"matcher": "*", "hooks": [{
                "type": "command", "command": "user-hook", "commandWindows": "user-hook.exe", "timeout": 5
            }]},
            {"matcher": "*", "hooks": [{
                "type": "command", "command": command, "commandWindows": windows_command, "timeout": 5
            }]}
        ]}});
        let mut state = InlineTable::new();
        state.insert(
            "trusted_hash",
            Value::from(crate::subagent_gate::hook_trust_hash(
                EVENT,
                Some("*"),
                &windows_command,
                5,
            )),
        );
        let mut states = InlineTable::new();
        states.insert(
            format!("{WINDOWS_HOOKS}:{EVENT}:1:0"),
            Value::InlineTable(state),
        );
        Self {
            _directory: directory,
            path,
            hooks,
            states,
        }
    }

    fn owned_hook(&mut self) -> &mut serde_json::Value {
        &mut self.hooks["hooks"]["PreToolUse"][1]["hooks"][0]
    }

    fn owned_state(&mut self) -> &mut InlineTable {
        self.states
            .get_mut(&format!("{WINDOWS_HOOKS}:{EVENT}:1:0"))
            .unwrap()
            .as_inline_table_mut()
            .unwrap()
    }

    fn mapped(&self) -> Result<InlineTable> {
        std::fs::write(&self.path, serde_json::to_vec(&self.hooks).unwrap()).unwrap();
        map_hook_states(&self.states, Path::new(WINDOWS_HOST), &mut |path| {
            assert_eq!(path, WINDOWS_HOOKS);
            Ok(self.path.to_string_lossy().into_owned())
        })
    }
}

#[test]
fn migrates_only_trusted_owned_hooks_and_preserves_disabled_state() {
    for argument in [
        crate::subagent_gate::HOOK_ARGUMENT,
        crate::subagent_gate::COMBINED_HOOK_ARGUMENT,
        crate::fastctx_route_gate::HOOK_ARGUMENT,
        crate::conversation_git::tracking::HOOK_ARGUMENT,
    ] {
        let mut fixture = HookFixture::new(argument);
        fixture.owned_state().insert("enabled", Value::from(false));
        let mapped = fixture.mapped().unwrap();
        assert_eq!(mapped.len(), 1, "user hook must not receive trust");
        let key = format!("{}:{EVENT}:1:0", fixture.path.display());
        let state = mapped.get(&key).unwrap().as_inline_table().unwrap();
        assert_eq!(state.get("enabled").and_then(Value::as_bool), Some(false));
        let expected = crate::subagent_gate::hook_trust_hash(
            EVENT,
            Some("*"),
            fixture.hooks["hooks"]["PreToolUse"][1]["hooks"][0]["command"]
                .as_str()
                .unwrap(),
            5,
        );
        assert_eq!(
            state.get("trusted_hash").and_then(Value::as_str),
            Some(expected.as_str())
        );
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&fixture.path).unwrap()).unwrap();
        assert_eq!(
            saved, fixture.hooks,
            "migration must not rewrite shared hooks"
        );
    }
}

#[test]
fn altered_posix_command_cannot_inherit_windows_hook_trust() {
    for command in [
        "user-hook --codey-subagent-gate-hook",
        "'/different/Codey.exe' --codey-subagent-gate-hook",
    ] {
        let mut fixture = HookFixture::new(crate::subagent_gate::HOOK_ARGUMENT);
        fixture.owned_hook()["command"] = json!(command);
        assert!(fixture.mapped().is_err());
    }
    let mut fixture = HookFixture::new(crate::subagent_gate::HOOK_ARGUMENT);
    let original = fixture.owned_hook()["command"].as_str().unwrap().to_owned();
    fixture.owned_hook()["command"] = json!(format!("{original}; echo injected-secret"));
    let error = fixture.mapped().unwrap_err().to_string();
    assert!(!error.contains("injected-secret"));
}

#[test]
fn missing_or_stale_windows_hash_cannot_authorize_linux_hook() {
    let mut fixture = HookFixture::new(crate::subagent_gate::HOOK_ARGUMENT);
    fixture
        .owned_state()
        .insert("trusted_hash", Value::from("sha256:stale"));
    assert!(fixture.mapped().is_err());
    fixture.owned_state().remove("trusted_hash");
    assert!(fixture.mapped().is_err());

    let mut fixture = HookFixture::new(crate::subagent_gate::HOOK_ARGUMENT);
    fixture.owned_hook()["commandWindows"] = json!("echo changed-command");
    assert!(fixture.mapped().is_err());
}

#[test]
fn changed_hook_execution_properties_require_fresh_trust() {
    for (field, changed) in [
        ("async", json!(true)),
        ("timeout", json!(100)),
        ("type", json!("prompt")),
    ] {
        let mut fixture = HookFixture::new(crate::subagent_gate::HOOK_ARGUMENT);
        fixture.owned_hook()[field] = changed;
        assert!(fixture.mapped().is_err(), "changed {field} was accepted");
    }
    let mut fixture = HookFixture::new(crate::subagent_gate::HOOK_ARGUMENT);
    fixture.hooks["hooks"]["PreToolUse"][1]["matcher"] = json!("Bash");
    assert!(fixture.mapped().is_err());
}

#[test]
fn user_hook_with_valid_windows_hash_does_not_gain_posix_trust() {
    let mut fixture = HookFixture::new(crate::subagent_gate::HOOK_ARGUMENT);
    let mut user_state = InlineTable::new();
    user_state.insert(
        "trusted_hash",
        Value::from(crate::subagent_gate::hook_trust_hash(
            EVENT,
            Some("*"),
            "user-hook.exe",
            5,
        )),
    );
    fixture.states.insert(
        format!("{WINDOWS_HOOKS}:{EVENT}:0:0"),
        Value::InlineTable(user_state),
    );
    assert!(fixture.mapped().is_err());
}

#[test]
fn invalid_hook_indices_fail_without_panicking_or_mapping_relative_paths() {
    for suffix in ["pre_tool_use:9:0", "pre_tool_use:1:9", "pre_tool_use:bad:0"] {
        let mut fixture = HookFixture::new(crate::subagent_gate::HOOK_ARGUMENT);
        let state = fixture.states.iter().next().unwrap().1.clone();
        fixture.states.clear();
        fixture
            .states
            .insert(format!("{WINDOWS_HOOKS}:{suffix}"), state);
        assert!(fixture.mapped().is_err());
    }
    let mut states = InlineTable::new();
    states.insert("bad-key", Value::InlineTable(InlineTable::new()));
    assert!(
        map_hook_states(&states, Path::new(WINDOWS_HOST), &mut |_| panic!(
            "invalid key must fail before filesystem access"
        ))
        .is_err()
    );
}
