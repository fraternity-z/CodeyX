use super::*;
use serde_json::json;

fn pool() -> NetworkProxyConfig {
    serde_json::from_value(json!({"nodes":[{"id":"exit","name":"Exit","enabled":true,
        "endpoint":{"protocol":"socks5","host":"proxy.invalid","port":1080}}],
        "policies":[{"id":"work","name":"Work","enabled":true,"rules":[],
            "defaultAction":{"kind":"proxy","targets":[{"kind":"node","id":"exit"}],"onFailure":"stop"}}]})).unwrap()
}

#[test]
fn old_settings_gain_no_rules_or_direct_authorization() {
    let old: NetworkProxyConfig = serde_json::from_value(json!({})).unwrap();
    assert!(old.policies.is_empty());
    assert_eq!(old.process_proxy, ProxySelection::Legacy);
    let policy: ProxyPolicy =
        serde_json::from_value(json!({"id":"p","name":"p","enabled":true})).unwrap();
    assert!(!policy.allow_direct);
    assert_eq!(policy.default_action, ProxyAction::Block);
}

#[test]
fn any_rule_does_not_fall_through_for_non_dns_hostnames() {
    let mut pool = pool();
    let policy = &mut pool.policies[0];
    policy.allow_direct = true;
    policy.default_action = ProxyAction::Direct;
    policy.rules.push(ProxyRule {
        id: "block-all".into(),
        enabled: true,
        host: HostMatch::Any,
        ports: vec![],
        action: ProxyAction::Block,
    });
    let destination = Destination::new("service_name.invalid", 443).unwrap();
    assert_eq!(policy.action(&destination), &ProxyAction::Block);
}

#[test]
fn ordered_rules_match_boundaries_ports_and_canonical_idna_without_dns() {
    let mut pool = pool();
    let policy = &mut pool.policies[0];
    policy.allow_direct = true;
    policy.rules = serde_json::from_value(json!([
        {"id":"first","enabled":true,"host":{"kind":"exact","value":"private.example.com"},"ports":[443],"action":{"kind":"block"}},
        {"id":"off","enabled":false,"host":{"kind":"any"},"action":{"kind":"block"}},
        {"id":"suffix","enabled":true,"host":{"kind":"suffix","value":"EXAMPLE.com."},"action":{"kind":"direct"}},
        {"id":"unicode","enabled":true,"host":{"kind":"exact","value":"例子.测试"},"action":{"kind":"direct"}}
    ])).unwrap();
    assert_eq!(
        policy.action(&Destination::new("PRIVATE.example.com", 443).unwrap()),
        &ProxyAction::Block
    );
    for (host, port) in [
        ("private.example.com", 80),
        ("example.com", 443),
        ("a.b.example.com", 443),
        ("xn--fsqu00a.xn--0zwm56d", 443),
    ] {
        assert_eq!(
            policy.action(&Destination::new(host, port).unwrap()),
            &ProxyAction::Direct
        );
    }
    for host in [
        "evil-example.com",
        "example.com.attacker.invalid",
        "nonexistent.invalid",
    ] {
        assert_eq!(
            policy.action(&Destination::new(host, 443).unwrap()),
            &policy.default_action
        );
    }
    pool.validate().unwrap();
}

#[test]
fn cidr_matches_literals_only_with_ipv4_ipv6_and_zero_prefix_boundaries() {
    for (cidr, yes, no) in [
        ("10.0.0.0/8", "10.255.255.255", "11.0.0.0"),
        ("2001:db8::/32", "2001:db8::1", "2001:db9::1"),
        ("192.0.2.1/32", "192.0.2.1", "192.0.2.2"),
        ("::1/128", "::1", "::2"),
        ("0.0.0.0/0", "203.0.113.1", "::1"),
        ("::/0", "2001:db8::1", "127.0.0.1"),
    ] {
        let matcher = HostMatch::Cidr { value: cidr.into() };
        matcher.validate().unwrap();
        assert!(matcher.matches(yes), "{cidr} / {yes}");
        assert!(!matcher.matches(no), "{cidr} / {no}");
        assert!(!matcher.matches("localhost"));
    }
    for value in [
        "10.1.0.1/8",
        "10.0.0.0/33",
        "::/129",
        "::1/0",
        "1.2.3.4",
        "hostname/8",
        "::/x",
    ] {
        assert!(cidr(value).is_err(), "{value}");
    }
}

#[test]
fn ipv4_mapped_addresses_cannot_bypass_ipv4_exact_or_cidr_rules() {
    for matcher in [
        HostMatch::Exact {
            value: "192.0.2.1".into(),
        },
        HostMatch::Cidr {
            value: "192.0.2.0/24".into(),
        },
    ] {
        assert!(matcher.matches("::ffff:192.0.2.1"));
        assert!(matcher.matches("::ffff:c000:201"));
        assert!(!matcher.matches("::ffff:c000:301"));
    }
    assert!(
        HostMatch::Cidr {
            value: "::ffff:0:0/96".into()
        }
        .matches("::ffff:192.0.2.1")
    );
    for value in [
        ".example.com",
        "example..com",
        "example.com..",
        "-example.com",
        "a_b.example",
    ] {
        assert!(
            HostMatch::Exact {
                value: value.into()
            }
            .validate()
            .is_err()
        );
    }
}

#[test]
fn every_direct_path_requires_explicit_consent_even_in_disabled_rules() {
    for action in [
        json!({"kind":"direct"}),
        json!({"kind":"proxy","targets":[{"kind":"node","id":"exit"}],"onFailure":"direct"}),
    ] {
        let mut pool = pool();
        pool.policies[0].default_action = serde_json::from_value(action.clone()).unwrap();
        assert!(pool.validate().unwrap_err().contains("显式允许"));
        pool.policies[0].allow_direct = true;
        pool.validate().unwrap();
        pool.policies[0].allow_direct = false;
        pool.policies[0].default_action = ProxyAction::Block;
        pool.policies[0].rules = serde_json::from_value(
            json!([{"id":"off","enabled":false,"host":{"kind":"any"},"action":action}]),
        )
        .unwrap();
        assert!(pool.validate().is_err());
    }
}

#[test]
fn reference_integrity_and_policy_disable_are_fail_closed() {
    let mut pool = pool();
    let selection = ProxySelection::Policy { id: "work".into() };
    pool.process_proxy = selection.clone();
    pool.validate_active_selection(&selection).unwrap();
    assert!(pool.resolve(&selection).is_err());
    assert!(pool.test_nodes(&selection).is_err());
    pool.policies[0].enabled = false;
    pool.validate().unwrap();
    assert!(
        pool.validate_active_selection(&selection)
            .unwrap_err()
            .contains("阻断")
    );
    pool.nodes.clear();
    assert!(pool.validate().is_err());
    pool.policies.clear();
    assert!(pool.validate().is_err());
}

#[test]
fn rejects_recursive_ambiguous_excessive_and_invalid_rule_configuration() {
    assert!(serde_json::from_value::<ProxyTarget>(json!({"kind":"policy","id":"work"})).is_err());
    for value in [
        json!({"kind":"suffix","value":"127.0.0.1"}),
        json!({"kind":"exact","value":"example.com/path"}),
        json!({"kind":"suffix","value":"*.example.com"}),
    ] {
        assert!(
            serde_json::from_value::<HostMatch>(value)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    for ports in [vec![0], vec![443, 443], (1..=33).collect::<Vec<u16>>()] {
        let mut pool = pool();
        pool.policies[0].rules.push(ProxyRule {
            id: "r".into(),
            enabled: true,
            host: HostMatch::Any,
            ports,
            action: ProxyAction::Block,
        });
        assert!(pool.validate().is_err());
    }
    for targets in [
        json!([]),
        json!([{"kind":"node","id":"exit"},{"kind":"node","id":"exit"}]),
        json!([{"kind":"node","id":"missing"}]),
    ] {
        let mut pool = pool();
        pool.policies[0].default_action =
            serde_json::from_value(json!({"kind":"proxy","targets":targets})).unwrap();
        assert!(pool.validate().is_err());
    }
}
