use std::fmt;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::model::{NetworkProxyConfig, ProxyProtocol};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProxyCredential {
    pub username: String,
    pub password: String,
}

impl fmt::Debug for ProxyCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProxyCredential([redacted])")
    }
}

impl ProxyCredential {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !(1..=255).contains(&self.username.len()) || !(1..=255).contains(&self.password.len()) {
            return Err("代理用户名和密码须分别为 1 到 255 个 UTF-8 字节".into());
        }
        Ok(())
    }

    pub(crate) fn validate_for(&self, protocol: ProxyProtocol) -> Result<(), String> {
        self.validate()?;
        if protocol != ProxyProtocol::Socks5 && self.username.contains(':') {
            return Err("HTTP 和 HTTPS 代理用户名不能包含冒号".into());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum CredentialChange {
    Clear,
    Replace { username: String, password: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CredentialUpdate {
    pub node_id: String,
    pub change: CredentialChange,
}

pub(crate) trait SecretStore {
    fn read(&self, node_id: &str, reference: &str) -> Result<ProxyCredential, String>;
    fn write(
        &self,
        node_id: &str,
        reference: &str,
        credential: &ProxyCredential,
    ) -> Result<(), String>;
    fn remove(&self, node_id: &str, reference: &str) -> Result<(), String>;
}

pub(crate) struct SystemSecretStore {
    service: String,
}

// Some native stores do not reliably order concurrent accesses to an entry.
static VAULT_LOCK: Mutex<()> = Mutex::new(());

impl SystemSecretStore {
    pub(crate) fn for_config(path: &Path) -> Self {
        Self {
            service: format!(
                "CodeyX.NetworkProxy.{:x}",
                Sha256::digest(path.to_string_lossy().as_bytes())
            ),
        }
    }

    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    fn entry(&self, node_id: &str, reference: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, &format!("{node_id}:{reference}"))
            .map_err(|_| "系统凭据存储不可用，请检查系统密钥库是否已解锁".into())
    }
}

impl SecretStore for SystemSecretStore {
    fn read(&self, node_id: &str, reference: &str) -> Result<ProxyCredential, String> {
        let _guard = VAULT_LOCK.lock().map_err(|_| "系统凭据存储状态异常")?;
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        {
            let value = self
                .entry(node_id, reference)?
                .get_password()
                .map_err(|_| "无法读取代理凭据，请解锁系统密钥库或重新填写凭据".to_string())?;
            serde_json::from_str(&value).map_err(|_| "保存的代理凭据格式无效，请重新填写".into())
        }
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        {
            let _ = (node_id, reference);
            Err("此平台尚不支持代理凭据安全存储".into())
        }
    }

    fn write(
        &self,
        node_id: &str,
        reference: &str,
        credential: &ProxyCredential,
    ) -> Result<(), String> {
        credential.validate()?;
        let _guard = VAULT_LOCK.lock().map_err(|_| "系统凭据存储状态异常")?;
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        {
            let value = serde_json::to_string(credential).map_err(|_| "代理凭据编码失败")?;
            let entry = self.entry(node_id, reference)?;
            entry
                .set_password(&value)
                .map_err(|_| "代理凭据未能保存到系统密钥库，配置未提交".to_string())?;
            let stored = entry
                .get_password()
                .map_err(|_| "无法确认代理凭据保存结果，配置未提交".to_string())?;
            if stored != value {
                return Err("代理凭据保存校验失败，配置未提交".into());
            }
            Ok(())
        }
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        {
            let _ = (node_id, reference);
            Err("此平台尚不支持代理凭据安全存储".into())
        }
    }

    fn remove(&self, node_id: &str, reference: &str) -> Result<(), String> {
        let _guard = VAULT_LOCK.lock().map_err(|_| "系统凭据存储状态异常")?;
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        {
            match self.entry(node_id, reference)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("未引用的代理凭据清理失败".into()),
            }
        }
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        {
            let _ = (node_id, reference);
            Err("此平台尚不支持代理凭据安全存储".into())
        }
    }
}

/// Copy-on-write credentials keep old snapshots and backups usable. Only fresh,
/// uncommitted entries are deleted on failure; existing references are immutable.
pub(crate) fn save_with_credentials<T>(
    previous: &NetworkProxyConfig,
    mut next: NetworkProxyConfig,
    updates: Vec<CredentialUpdate>,
    store: &dyn SecretStore,
    persist: impl FnOnce(NetworkProxyConfig) -> Result<T, String>,
) -> Result<T, String> {
    next.validate()?;
    for node in &next.nodes {
        let previous_ref = previous
            .nodes
            .iter()
            .find(|old| old.id == node.id)
            .and_then(|old| old.credential_ref.as_ref());
        if node.credential_ref.as_ref() != previous_ref {
            return Err("代理凭据引用不能直接修改，请使用保留、替换或清除操作".into());
        }
    }
    let mut seen = std::collections::HashSet::new();
    for update in &updates {
        let node = next.node(&update.node_id)?;
        if !seen.insert(&update.node_id) {
            return Err("同一代理不能重复提交凭据操作".into());
        }
        if let CredentialChange::Replace { username, password } = &update.change {
            ProxyCredential {
                username: username.clone(),
                password: password.clone(),
            }
            .validate_for(node.endpoint.protocol)?;
        }
    }
    let mut staged = Vec::<(String, String)>::new();
    let result = (|| {
        for update in updates {
            let node = next
                .nodes
                .iter_mut()
                .find(|node| node.id == update.node_id)
                .unwrap();
            match update.change {
                CredentialChange::Clear => node.credential_ref = None,
                CredentialChange::Replace { username, password } => {
                    let reference = uuid::Uuid::new_v4().to_string();
                    // Include ambiguous writes in rollback as well.
                    staged.push((node.id.clone(), reference.clone()));
                    store.write(
                        &node.id,
                        &reference,
                        &ProxyCredential { username, password },
                    )?;
                    node.credential_ref = Some(reference);
                }
            }
        }
        persist(next)
    })();
    if result.is_err() {
        let failed_cleanup = staged
            .iter()
            .filter(|(node, reference)| store.remove(node, reference).is_err())
            .count();
        if failed_cleanup > 0 {
            return result.map_err(|error| format!("{error}；部分未引用凭据未能从系统密钥库清理"));
        }
    }
    result
}

#[cfg(test)]
mod tests;
