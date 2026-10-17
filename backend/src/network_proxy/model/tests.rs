use super::*;

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
fn chains_preserve_order_and_reject_loops_and_dangling_references() {
    let mut config = NetworkProxyConfig {
        nodes: vec![node("first"), node("second")],
        chains: vec![ProxyChain {
            id: "chain".into(),
            name: "chain".into(),
            enabled: true,
            node_ids: vec!["second".into(), "first".into()],
        }],
        ..Default::default()
    };
    let selection = ProxySelection::Chain { id: "chain".into() };
    let plan = config.resolve(&selection).unwrap().unwrap();
    assert_eq!(
        plan.iter().map(|node| node.id.as_str()).collect::<Vec<_>>(),
        ["second", "first"]
    );
    config.nodes.reverse(); // UI order must not change a selected path.
    assert_eq!(config.resolve(&selection).unwrap().unwrap(), plan);
    config.chains[0].node_ids.push("second".into());
    assert!(config.validate().is_err());
    config.chains[0].node_ids = vec!["first".into(), "missing".into()];
    assert!(config.validate().is_err());
    config.chains[0].node_ids = vec!["first".into()];
    config.chains[0].enabled = false;
    assert!(config.resolve(&selection).is_err());
}

#[test]
fn later_loopback_hops_are_rejected() {
    let mut config = NetworkProxyConfig {
        nodes: vec![node("first"), node("second")],
        chains: vec![ProxyChain {
            id: "chain".into(),
            name: "chain".into(),
            enabled: true,
            node_ids: vec!["first".into(), "second".into()],
        }],
        ..Default::default()
    };
    for host in [
        "127.0.0.1",
        "::1",
        "localhost",
        "LOCALHOST.",
        "proxy.localhost",
        "127.1",
        "0x7f000001",
        "[::ffff:127.0.0.1]",
    ] {
        config.nodes[1].endpoint.host = host.into();
        assert!(config.validate().is_err());
    }
    config.chains[0].node_ids.reverse();
    assert!(config.validate().is_ok());
}

#[test]
fn chain_endpoint_identity_is_independent_of_protocol_dns_and_host_spelling() {
    let mut first = node("first");
    first.endpoint.host = "Proxy.Example.".into();
    let mut second = node("second");
    second.endpoint.host = "proxy.example".into();
    second.endpoint.protocol = ProxyProtocol::Https;
    let mut config = NetworkProxyConfig {
        nodes: vec![first, second],
        chains: vec![ProxyChain {
            id: "chain".into(),
            name: "chain".into(),
            enabled: true,
            node_ids: vec!["first".into(), "second".into()],
        }],
        ..Default::default()
    };
    assert!(config.validate().unwrap_err().contains("同一端点"));
    config.nodes[1].endpoint.port = 443;
    assert!(config.validate().is_ok());
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

#[test]
fn manual_test_can_inspect_disabled_chain_but_never_relaxes_runtime_selection() {
    let mut config = NetworkProxyConfig {
        nodes: vec![node("first"), node("second")],
        chains: vec![ProxyChain {
            id: "chain".into(),
            name: "chain".into(),
            enabled: false,
            node_ids: vec!["second".into(), "first".into()],
        }],
        ..Default::default()
    };
    config.nodes[0].enabled = false;
    let selection = ProxySelection::Chain { id: "chain".into() };
    let tested = config.test_nodes(&selection).unwrap();
    assert_eq!(
        tested
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        ["second", "first"]
    );
    assert!(!tested[1].enabled);
    assert!(config.resolve(&selection).is_err());
    assert!(config.test_nodes(&ProxySelection::Legacy).is_err());
    assert!(
        config
            .test_nodes(&ProxySelection::Chain {
                id: "missing".into()
            })
            .is_err()
    );
    config.chains[0].node_ids.push("second".into());
    assert!(config.test_nodes(&selection).is_err());
}
