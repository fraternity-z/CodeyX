use super::*;
use crate::network_proxy::model::{DnsMode, ProxyEndpoint, ProxyNode, ProxyProtocol};
use std::{cell::RefCell, collections::HashMap};

#[derive(Default)]
struct MemoryStore {
    entries: RefCell<HashMap<String, ProxyCredential>>,
    fail_write: bool,
}
impl SecretStore for MemoryStore {
    fn read(&self, _: &str, reference: &str) -> Result<ProxyCredential, String> {
        self.entries
            .borrow()
            .get(reference)
            .cloned()
            .ok_or("missing".into())
    }
    fn write(&self, _: &str, reference: &str, credential: &ProxyCredential) -> Result<(), String> {
        if self.fail_write {
            return Err("vault locked".into());
        }
        self.entries
            .borrow_mut()
            .insert(reference.into(), credential.clone());
        Ok(())
    }
    fn remove(&self, _: &str, reference: &str) -> Result<(), String> {
        self.entries.borrow_mut().remove(reference);
        Ok(())
    }
}
fn config() -> NetworkProxyConfig {
    NetworkProxyConfig {
        nodes: vec![ProxyNode {
            id: "node".into(),
            name: "出口".into(),
            endpoint: ProxyEndpoint {
                protocol: ProxyProtocol::Socks5,
                host: "proxy.example".into(),
                port: 1080,
                dns: DnsMode::Remote,
            },
            credential_ref: None,
            notes: String::new(),
            enabled: true,
            tags: Vec::new(),
            group: String::new(),
        }],
        ..Default::default()
    }
}
fn update() -> Vec<CredentialUpdate> {
    vec![CredentialUpdate {
        node_id: "node".into(),
        change: CredentialChange::Replace {
            username: "test-user".into(),
            password: " test-password ".into(),
        },
    }]
}

#[test]
fn secret_values_never_enter_config_or_debug_and_whitespace_is_preserved() {
    let store = MemoryStore::default();
    let saved = save_with_credentials(&config(), config(), update(), &store, Ok).unwrap();
    let json = serde_json::to_string(&saved).unwrap();
    assert!(!json.contains("test-password"));
    assert!(!json.contains("test-user"));
    let credential = store
        .read("node", saved.nodes[0].credential_ref.as_ref().unwrap())
        .unwrap();
    assert_eq!(credential.password, " test-password ");
    assert!(!format!("{credential:?}").contains("test-password"));
}

#[test]
fn failed_config_commit_rolls_back_new_secret_without_overwriting_old_secret() {
    let store = MemoryStore::default();
    let saved = save_with_credentials(&config(), config(), update(), &store, Ok).unwrap();
    let old = store.entries.borrow().clone();
    let result = save_with_credentials::<()>(&saved, saved.clone(), update(), &store, |_| {
        Err("disk full".into())
    });
    assert!(result.is_err());
    assert_eq!(*store.entries.borrow(), old);
}

#[test]
fn locked_vault_does_not_commit_or_fallback_to_plaintext() {
    let store = MemoryStore {
        fail_write: true,
        ..Default::default()
    };
    assert!(
        save_with_credentials::<()>(&config(), config(), update(), &store, |_| panic!(
            "must not persist"
        ))
        .is_err()
    );
    assert!(store.entries.borrow().is_empty());
}

#[test]
fn caller_cannot_substitute_secret_reference_and_invalid_update_is_atomic() {
    let store = MemoryStore::default();
    let mut next = config();
    next.nodes[0].credential_ref = Some(uuid::Uuid::new_v4().to_string());
    assert!(save_with_credentials(&config(), next, vec![], &store, Ok).is_err());
    let mut updates = update();
    updates.extend(update());
    assert!(save_with_credentials(&config(), config(), updates, &store, Ok).is_err());
    assert!(store.entries.borrow().is_empty());
}

#[test]
fn keep_and_clear_do_not_destroy_credential_referenced_by_rollback_snapshot() {
    let store = MemoryStore::default();
    let saved = save_with_credentials(&config(), config(), update(), &store, Ok).unwrap();
    let kept = save_with_credentials(&saved, saved.clone(), vec![], &store, Ok).unwrap();
    assert_eq!(kept, saved);
    let cleared = save_with_credentials(
        &saved,
        saved.clone(),
        vec![CredentialUpdate {
            node_id: "node".into(),
            change: CredentialChange::Clear,
        }],
        &store,
        Ok,
    )
    .unwrap();
    assert_eq!(cleared.nodes[0].credential_ref, None);
    assert!(
        store
            .read("node", saved.nodes[0].credential_ref.as_ref().unwrap())
            .is_ok()
    );
}
