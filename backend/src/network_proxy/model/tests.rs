use super::*;

#[test]
fn retired_selections_round_trip_but_never_execute() {
    let config: NetworkProxyConfig = serde_json::from_value(serde_json::json!({
        "chains":[{"id":"old","name":"Old","enabled":true,"nodeIds":["removed"]}],
        "policies":[{"id":"old","name":"Old","enabled":true,"defaultAction":{"kind":"direct"}}],
        "upstreamByProfile":{"route":{"kind":"chain","id":"old"}}
    }))
    .unwrap();
    config.validate().unwrap();
    for selection in [
        ProxySelection::Chain { id: "old".into() },
        ProxySelection::Policy { id: "old".into() },
    ] {
        assert!(config.resolve(&selection).unwrap_err().contains("已移除"));
        assert!(
            config
                .test_nodes(&selection)
                .unwrap_err()
                .contains("已移除")
        );
    }
    let restored: NetworkProxyConfig =
        serde_json::from_value(serde_json::to_value(&config).unwrap()).unwrap();
    assert_eq!(restored, config);
}

#[test]
fn route_switch_preserves_selection_and_disables_its_validation_and_pool_requirement() {
    let mut config = NetworkProxyConfig::default();
    config
        .upstream_enabled_by_profile
        .insert("route".into(), true);
    assert!(config.validate().unwrap_err().contains("请选择"));
    config.upstream_enabled_by_profile.clear();
    config.upstream_by_profile.insert(
        "route".into(),
        ProxySelection::Node {
            id: "missing".into(),
        },
    );
    assert!(config.uses_pool("route"));
    assert!(config.validate().is_err());
    config
        .upstream_enabled_by_profile
        .insert("route".into(), false);
    assert!(!config.uses_pool("route"));
    assert!(!config.has_upstream_bindings());
    config.validate().unwrap();
    assert!(config.upstream_by_profile.contains_key("route"));
    config
        .upstream_enabled_by_profile
        .insert("route".into(), true);
    assert!(config.validate().is_err());
}

pub(crate) fn node(id: &str) -> ProxyNode {
    ProxyNode {
        id: id.into(),
        name: id.into(),
        endpoint: ProxyEndpoint {
            protocol: ProxyProtocol::Socks5,
            host: format!("{id}.example"),
            port: 1080,
            dns: DnsMode::Remote,
        },
        credential_ref: None,
        notes: String::new(),
        enabled: true,
        tags: Vec::new(),
        group: String::new(),
    }
}

#[test]
fn endpoints_validate_and_preserve_dns_and_ipv6() {
    let mut endpoint = node("first").endpoint;
    assert_eq!(
        endpoint.url().unwrap().as_str(),
        "socks5h://first.example:1080"
    );
    endpoint.dns = DnsMode::Local;
    assert_eq!(endpoint.url().unwrap().scheme(), "socks5");
    endpoint.host = "::1".into();
    assert_eq!(endpoint.url().unwrap().as_str(), "socks5://[::1]:1080");
    endpoint.host = "[2001:db8::1]".into();
    assert_eq!(
        endpoint.url().unwrap().as_str(),
        "socks5://[2001:db8::1]:1080"
    );
    for host in [
        "",
        "0.0.0.0",
        "::",
        "224.0.0.1",
        "0",
        "0xe0000001",
        "[::ffff:0.0.0.0]",
        "[[::1]]",
        "[127.0.0.1]",
        "host/path",
        "user:secret@host",
        "host?query",
        "*.example",
        "host\n",
        "example:80",
        "[broken]",
    ] {
        endpoint.host = host.into();
        assert!(endpoint.url().is_err(), "{host}");
    }
    endpoint.host = "proxy.example".into();
    endpoint.port = 0;
    assert!(endpoint.url().is_err());
    endpoint.port = 443;
    endpoint.protocol = ProxyProtocol::Https;
    assert!(endpoint.url().is_err());
    endpoint.dns = DnsMode::Remote;
    assert_eq!(endpoint.url().unwrap().scheme(), "https");
}

#[test]
fn missing_disabled_or_deleted_nodes_never_resolve_to_direct() {
    let mut config = NetworkProxyConfig {
        nodes: vec![node("first")],
        ..Default::default()
    };
    assert_eq!(config.resolve(&ProxySelection::Legacy).unwrap(), None);
    assert!(
        config
            .resolve(&ProxySelection::Node {
                id: "missing".into()
            })
            .is_err()
    );
    let selection = ProxySelection::Node { id: "first".into() };
    assert_eq!(config.resolve(&selection).unwrap().unwrap()[0].id, "first");
    config.nodes[0].enabled = false;
    assert!(config.resolve(&selection).unwrap_err().contains("阻断"));
    config.nodes.clear();
    assert!(config.resolve(&selection).is_err());
}

#[test]
fn pool_rejects_duplicate_ids_unknown_versions_and_invalid_metadata() {
    let mut config = NetworkProxyConfig {
        nodes: vec![node("first"), node("first")],
        ..Default::default()
    };
    assert!(config.validate().is_err());
    config.nodes.pop();
    config.schema_version = 99;
    assert!(config.validate().is_err());
    config.schema_version = 1;
    config.nodes[0].tags = vec!["tag".into(), "tag".into()];
    assert!(config.validate().is_err());
    config.nodes[0].tags.clear();
    config.nodes[0].name = " ".into();
    assert!(config.validate().is_err());
}

#[test]
fn old_config_defaults_to_empty_pool_without_rewriting_legacy_proxy() {
    let config: crate::config::CodeyConfig = serde_json::from_value(serde_json::json!({
        "codexLaunchProxy": "socks5://127.0.0.1:1080"
    }))
    .unwrap();
    assert_eq!(config.network_proxy, NetworkProxyConfig::default());
    assert_eq!(config.codex_launch_proxy, "socks5://127.0.0.1:1080");
}

#[test]
fn process_proxy_references_survive_disable_but_prevent_deletion() {
    let mut config = NetworkProxyConfig {
        nodes: vec![node("exit")],
        process_proxy: ProxySelection::Node { id: "exit".into() },
        ..Default::default()
    };
    assert!(config.has_process_proxy());
    assert!(!config.has_upstream_bindings());
    config.nodes[0].enabled = false;
    assert!(config.validate().is_ok());
    assert!(
        config
            .resolve(&config.process_proxy)
            .unwrap_err()
            .contains("阻断")
    );
    config.nodes.clear();
    assert!(config.validate().is_err());
    config.process_proxy = ProxySelection::Legacy;
    assert!(config.validate().is_ok());
    assert!(!config.has_process_proxy());
}

#[test]
fn traffic_capture_is_opt_in_and_requires_an_explicit_pool_exit() {
    let mut config: NetworkProxyConfig = serde_json::from_str("{}").unwrap();
    assert!(!config.process_capture);
    assert!(
        serde_json::to_value(&config)
            .unwrap()
            .get("processCapture")
            .is_none()
    );
    config.process_capture = true;
    assert!(config.validate().unwrap_err().contains("请选择代理池"));
    config.nodes = vec![node("exit")];
    config.process_proxy = ProxySelection::Node { id: "exit".into() };
    config.validate().unwrap();
    let restored: NetworkProxyConfig =
        serde_json::from_value(serde_json::to_value(&config).unwrap()).unwrap();
    assert_eq!(restored, config);
}
