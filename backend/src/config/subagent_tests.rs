use super::*;

fn custom() -> SubagentRoleConfig {
    SubagentRoleConfig {
        name: "审查员".into(),
        description: "独立核验改动".into(),
        developer_instructions: "报告结论和证据".into(),
        access: SubagentAccess::ReadOnly,
        ..SubagentRoleConfig::new("review-model", "high")
    }
}

#[test]
fn custom_subagent_roundtrip_keeps_instructions_access_and_selection() {
    let mut config = CodeyConfig::default();
    config.subagent_roles.insert("reviewer".into(), custom());
    config.subagent_max_threads = 8;
    let json = serde_json::to_vec(&config).unwrap();
    let decoded: CodeyConfig = serde_json::from_slice(&json).unwrap();
    let decoded = decoded.normalize();
    assert_eq!(decoded.subagent_roles["reviewer"], custom());
    assert_eq!(decoded.subagent_max_threads, 8);
    validate_subagent_config(&decoded).unwrap();
    assert_eq!(
        serde_json::from_str::<CodeyConfig>("{}")
            .unwrap()
            .subagent_max_threads,
        2
    );
    assert!(serde_json::from_str::<SubagentRoleConfig>(r#"{"access":"invalid"}"#).is_err());
}

#[test]
fn custom_subagent_rejects_unsafe_identifiers_and_missing_metadata() {
    for id in [
        "../evil",
        "a/b",
        "a.b",
        "CON",
        "con",
        "aux",
        "lpt1",
        "max_threads",
        "enabled",
        "",
        "review-role",
    ] {
        let mut config = CodeyConfig::default();
        config.subagent_roles.insert(id.into(), custom());
        assert!(validate_subagent_config(&config).is_err(), "{id}");
    }
    for field in ["name", "description", "developerInstructions"] {
        let mut value = serde_json::to_value(custom()).unwrap();
        value[field] = serde_json::Value::String(" ".into());
        let mut config = CodeyConfig::default();
        config
            .subagent_roles
            .insert("reviewer".into(), serde_json::from_value(value).unwrap());
        assert!(validate_subagent_config(&config).is_err(), "{field}");
    }
}

#[test]
fn subagent_limits_and_enabled_roles_are_validated() {
    let mut config = CodeyConfig::default();
    for limit in [1, 64] {
        config.subagent_max_threads = limit;
        validate_subagent_config(&config).unwrap();
    }
    for limit in [0, 65, u32::MAX] {
        config.subagent_max_threads = limit;
        assert!(validate_subagent_config(&config).is_err());
    }
    config.subagent_max_threads = 2;
    config.subagent_optimization = true;
    for selection in config.subagent_roles.values_mut() {
        selection.enabled = false;
    }
    config.subagent_roles.get_mut("default").unwrap().enabled = true;
    assert!(validate_subagent_config(&config).is_err());
    config.subagent_roles.insert("reviewer".into(), custom());
    validate_subagent_config(&config).unwrap();
    for index in 0..32 {
        config
            .subagent_roles
            .insert(format!("custom_{index}"), custom());
    }
    assert!(validate_subagent_config(&config).is_err());
}
