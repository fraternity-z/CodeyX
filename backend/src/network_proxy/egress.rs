//! Shared gateway preparation for Codey-owned requests. Callers retain the lease
//! until the response body or stream finishes; cache eviction cannot cut it off.
use std::{
    collections::VecDeque,
    path::Path,
    sync::{Arc, OnceLock},
    time::Duration,
};

use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Semaphore};

use super::{
    forwarding::Forwarder,
    gateway::Gateway,
    model::{NetworkProxyConfig, ProxyNode, ProxySelection},
    secrets::{SecretStore, SystemSecretStore},
    tunnel::{Destination, Hop, Tunnel, TunnelError},
};

const MAX_CACHED_GATEWAYS: usize = 16;
const PREPARE_TIMEOUT: Duration = Duration::from_secs(10);
static SECRET_READS: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[derive(Clone)]
pub(crate) struct ProxyLease {
    gateway: Arc<Gateway>,
}

impl std::fmt::Debug for ProxyLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ProxyLease([private gateway])")
    }
}

impl ProxyLease {
    pub(crate) async fn connect(&self, destination: Destination) -> Result<Tunnel, TunnelError> {
        self.gateway.connect(destination).await
    }

    /// A private loopback credential, never a setting or a value for user-facing logs.
    pub(crate) fn proxy_url(&self) -> String {
        self.gateway.proxy_url()
    }
}

/// Retain this value until the request body/response stream has finished.
/// Its private URL must never be written back to a profile or auth document.
pub(crate) struct PreparedProxy {
    url: Option<String>,
    lease: Option<ProxyLease>,
}

impl PreparedProxy {
    pub(crate) fn as_deref(&self) -> Option<&str> {
        self.url.as_deref()
    }
    pub(crate) fn uses_pool(&self) -> bool {
        self.lease.is_some()
    }
    pub(crate) fn bind(self, client: reqwest::Client) -> PreparedClient {
        PreparedClient {
            client,
            proxy: self,
        }
    }
}

pub(crate) struct PreparedClient {
    client: reqwest::Client,
    pub(crate) proxy: PreparedProxy,
}

impl std::ops::Deref for PreparedClient {
    type Target = reqwest::Client;
    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

pub(crate) struct EgressPool {
    policy: std::sync::RwLock<Arc<NetworkProxyConfig>>,
    store: Arc<dyn SecretStore + Send + Sync>,
    sessions: Mutex<VecDeque<([u8; 32], ProxyLease)>>,
    capacity: usize,
    configuration_recovery_required: bool,
}

impl EgressPool {
    pub(crate) fn for_config(path: &Path, policy: NetworkProxyConfig) -> Self {
        Self {
            policy: std::sync::RwLock::new(Arc::new(policy)),
            store: Arc::new(SystemSecretStore::for_config(path)),
            sessions: Mutex::new(VecDeque::new()),
            capacity: MAX_CACHED_GATEWAYS,
            configuration_recovery_required: false,
        }
    }

    pub(crate) fn require_configuration_recovery(&mut self) {
        self.configuration_recovery_required = true;
    }

    pub(crate) fn configure(&self, policy: NetworkProxyConfig) {
        *self
            .policy
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(policy);
    }

    pub(crate) async fn for_profile(&self, profile: &str) -> Result<Option<ProxyLease>, String> {
        self.prepare_current(|policy| {
            policy
                .upstream_by_profile
                .get(profile)
                .cloned()
                .unwrap_or_default()
        })
        .await
    }

    /// A managed process ingress keeps its startup selection while pool edits
    /// still take effect for each new connection. Legacy never means direct here.
    pub(crate) async fn for_selection(
        &self,
        selection: &ProxySelection,
    ) -> Result<ProxyLease, String> {
        self.prepare_current(|_| selection.clone())
            .await?
            .ok_or_else(|| "Codex 启动出口未指定代理池节点或链路；连接已阻断".into())
    }

    async fn prepare_current(
        &self,
        select: impl Fn(&NetworkProxyConfig) -> ProxySelection,
    ) -> Result<Option<ProxyLease>, String> {
        if self.configuration_recovery_required {
            return Err(
                "主配置未能完整读取，无法确认代理出口，连接已暂停；请恢复配置后重新打开 Codey"
                    .into(),
            );
        }
        for _ in 0..2 {
            let policy = self
                .policy
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            let selection = select(&policy);
            let prepared = self.prepare(&policy, &selection).await;
            if Arc::ptr_eq(
                &policy,
                &self
                    .policy
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            ) {
                return prepared;
            }
        }
        Err("准备连接期间网络代理设置发生变化，请重试；请求未转为直连".into())
    }

    pub(crate) async fn proxy_for_profile(
        &self,
        profile: &str,
        legacy: Option<&str>,
        plugin_transport: bool,
    ) -> Result<PreparedProxy, String> {
        let lease = self.for_profile(profile).await?;
        if lease.is_some() && plugin_transport {
            return Err("此插件自行建立网络连接，暂不支持代理池出口；请求已阻断".into());
        }
        let url = lease.as_ref().map(ProxyLease::proxy_url).or_else(|| {
            legacy
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(str::to_owned)
        });
        Ok(PreparedProxy { url, lease })
    }

    pub(crate) async fn prepare(
        &self,
        pool: &NetworkProxyConfig,
        selection: &ProxySelection,
    ) -> Result<Option<ProxyLease>, String> {
        // Resolve on every call, before a cache hit: disabling or deleting a selected
        // node must not reuse an earlier connection policy or become direct traffic.
        let (nodes, identity) = if let ProxySelection::Policy { id } = selection {
            pool.validate_active_selection(selection)?;
            (
                None,
                serde_json::to_vec(&(pool.policy(id)?, &pool.nodes, &pool.chains)),
            )
        } else {
            let Some(nodes) = pool.resolve(selection)? else {
                return Ok(None);
            };
            let identity = serde_json::to_vec(
                &nodes
                    .iter()
                    .map(|node| (&node.id, &node.endpoint, &node.credential_ref))
                    .collect::<Vec<_>>(),
            );
            (Some(nodes), identity)
        };
        let key: [u8; 32] = Sha256::digest(identity.map_err(|_| "代理连接配置编码失败")?).into();
        let mut sessions = tokio::time::timeout(PREPARE_TIMEOUT, self.sessions.lock())
            .await
            .map_err(|_| "代理入口正在准备，请稍后重试；请求未转为直连")?;
        if let Some(index) = sessions.iter().position(|(existing, _)| *existing == key) {
            let cached = sessions.remove(index).unwrap();
            let lease = cached.1.clone();
            sessions.push_back(cached);
            return Ok(Some(lease));
        }
        let gateway = tokio::time::timeout(PREPARE_TIMEOUT, async {
            let forwarder = match (nodes, selection) {
                (Some(nodes), _) => {
                    Forwarder::fixed(prepare_hops(nodes, self.store.clone()).await?).await?
                }
                (None, ProxySelection::Policy { id }) => {
                    Forwarder::policy(pool.clone(), id, self.store.clone())?
                }
                _ => return Err("出口选择无效，连接已阻断".into()),
            };
            Gateway::start_forwarder(forwarder).await
        })
        .await
        .map_err(|_| "本地代理入口准备超时，请检查系统证书与端口权限")??;
        let lease = ProxyLease {
            gateway: Arc::new(gateway),
        };
        if sessions.len() >= self.capacity {
            sessions.pop_front();
        }
        sessions.push_back((key, lease.clone()));
        Ok(Some(lease))
    }
}

/// Runtime preparation and explicit diagnostics share the same bounded native
/// key-store reads. A timed-out OS call retains its permit until it really ends.
pub(crate) async fn prepare_hops(
    nodes: Vec<ProxyNode>,
    store: Arc<dyn SecretStore + Send + Sync>,
) -> Result<Vec<Hop>, String> {
    if nodes.iter().all(|node| node.credential_ref.is_none()) {
        return Ok(nodes
            .into_iter()
            .map(|node| Hop {
                node,
                credential: None,
            })
            .collect());
    }
    let permit = SECRET_READS
        .get_or_init(|| Arc::new(Semaphore::new(4)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| "系统密钥库读取仍在处理，请解锁后重试；请求未转为直连")?;
    let read = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        nodes
            .into_iter()
            .map(|node| {
                let credential = node
                    .credential_ref
                    .as_ref()
                    .map(|reference| store.read(&node.id, reference))
                    .transpose()?;
                if let Some(credential) = &credential {
                    credential.validate_for(node.endpoint.protocol)?;
                }
                Ok(Hop { node, credential })
            })
            .collect::<Result<Vec<_>, String>>()
    });
    tokio::time::timeout(PREPARE_TIMEOUT, read)
        .await
        .map_err(|_| "读取系统代理凭据超时，请解锁系统密钥库后重试")?
        .map_err(|_| "读取系统代理凭据任务异常退出")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_proxy::{
        model::{DnsMode, ProxyEndpoint, ProxyNode, ProxyProtocol},
        secrets::ProxyCredential,
    };
    use std::{
        collections::HashMap,
        sync::{
            Mutex as BlockingMutex,
            atomic::{AtomicUsize, Ordering},
        },
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[derive(Default)]
    struct MemorySecrets {
        values: BlockingMutex<HashMap<String, ProxyCredential>>,
        reads: AtomicUsize,
    }
    impl SecretStore for MemorySecrets {
        fn read(&self, _node: &str, reference: &str) -> Result<ProxyCredential, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.values
                .lock()
                .unwrap()
                .get(reference)
                .cloned()
                .ok_or("系统密钥库已锁定".into())
        }
        fn write(&self, _: &str, _: &str, _: &ProxyCredential) -> Result<(), String> {
            panic!("preparation must not write credentials")
        }
        fn remove(&self, _: &str, _: &str) -> Result<(), String> {
            panic!("preparation must not delete credentials")
        }
    }

    fn node(id: &str, port: u16) -> ProxyNode {
        ProxyNode {
            id: id.into(),
            name: id.into(),
            endpoint: ProxyEndpoint {
                protocol: ProxyProtocol::Http,
                host: "127.0.0.1".into(),
                port,
                dns: DnsMode::Remote,
            },
            credential_ref: None,
            enabled: true,
            notes: String::new(),
            tags: vec![],
            group: String::new(),
        }
    }

    fn service(store: Arc<MemorySecrets>, capacity: usize) -> EgressPool {
        EgressPool {
            policy: std::sync::RwLock::new(Arc::new(NetworkProxyConfig::default())),
            store,
            sessions: Mutex::new(VecDeque::new()),
            capacity,
            configuration_recovery_required: false,
        }
    }

    #[tokio::test]
    async fn policy_changes_apply_to_new_leases_and_disabled_policies_never_become_legacy() {
        let service = service(Arc::new(MemorySecrets::default()), 2);
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut pool: NetworkProxyConfig = serde_json::from_value(serde_json::json!({
            "policies":[{"id":"work","name":"Work","enabled":true,"allowDirect":true,"defaultAction":{"kind":"direct"}}],
            "upstreamByProfile":{"route":{"kind":"policy","id":"work"}}
        })).unwrap();
        service.configure(pool.clone());
        let first = service.for_profile("route").await.unwrap().unwrap();
        assert_eq!(
            first.proxy_url(),
            service
                .for_profile("route")
                .await
                .unwrap()
                .unwrap()
                .proxy_url()
        );
        let destination =
            Destination::new("127.0.0.1", target.local_addr().unwrap().port()).unwrap();
        let mut stream = first.connect(destination.clone()).await.unwrap();
        let (mut origin, _) = target.accept().await.unwrap();
        pool.policies[0].default_action = super::super::routing::ProxyAction::Block;
        pool.policies[0].allow_direct = false;
        service.configure(pool.clone());
        let blocked = service.for_profile("route").await.unwrap().unwrap();
        assert_ne!(first.proxy_url(), blocked.proxy_url());
        assert_eq!(
            blocked.connect(destination).await.err().unwrap().kind,
            super::super::tunnel::FailureKind::Blocked
        );
        stream.write_all(b"live").await.unwrap();
        let mut bytes = [0; 4];
        origin.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"live");
        pool.policies[0].enabled = false;
        service.configure(pool);
        assert!(
            service
                .proxy_for_profile("route", Some("http://127.0.0.1:9"), false)
                .await
                .err()
                .unwrap()
                .contains("阻断")
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn profile_selection_preserves_legacy_only_when_explicit_and_survives_policy_changes() {
        let service = service(Arc::new(MemorySecrets::default()), 2);
        let manual = "http://127.0.0.1:9";
        assert_eq!(
            service
                .proxy_for_profile("route", Some(manual), false)
                .await
                .unwrap()
                .as_deref(),
            Some(manual)
        );
        let mut policy = NetworkProxyConfig {
            nodes: vec![node("selected", 1080)],
            ..Default::default()
        };
        policy.upstream_by_profile.insert(
            "route".into(),
            ProxySelection::Node {
                id: "selected".into(),
            },
        );
        service.configure(policy.clone());
        let prepared = service
            .proxy_for_profile("route", Some(manual), false)
            .await
            .unwrap();
        assert!(prepared.uses_pool());
        assert_ne!(prepared.as_deref(), Some(manual));
        assert!(
            service
                .proxy_for_profile("route", Some(manual), true)
                .await
                .is_err()
        );
        policy.nodes[0].enabled = false;
        service.configure(policy.clone());
        assert!(
            service
                .proxy_for_profile("route", Some(manual), false)
                .await
                .is_err()
        );
        policy.upstream_by_profile.clear();
        service.configure(policy);
        assert_eq!(
            service
                .proxy_for_profile("route", Some(manual), false)
                .await
                .unwrap()
                .as_deref(),
            Some(manual)
        );
    }

    #[tokio::test]
    async fn model_and_official_clients_use_the_prepared_exit_instead_of_legacy_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut policy = NetworkProxyConfig {
            nodes: vec![node("exit", listener.local_addr().unwrap().port())],
            ..Default::default()
        };
        policy
            .upstream_by_profile
            .insert("profile".into(), ProxySelection::Node { id: "exit".into() });
        let service = service(Arc::new(MemorySecrets::default()), 2);
        service.configure(policy);
        let prepared = service
            .proxy_for_profile("profile", Some("http://127.0.0.1:9"), false)
            .await
            .unwrap();
        let serving = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(stream.read_u8().await.unwrap());
                }
                assert!(
                    String::from_utf8(head)
                        .unwrap()
                        .starts_with("CONNECT catalog.invalid:80 HTTP/1.1")
                );
                stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
                let request = crate::local_router::read_http_request(&mut stream)
                    .await
                    .unwrap();
                assert_eq!(request.method, "GET");
                crate::local_router::write_json_response(
                    &mut stream,
                    200,
                    &serde_json::json!({"data":[{"id":"fixture-model"}]}),
                )
                .await
                .unwrap();
            }
        });
        let default = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let mut profile = crate::config::ProviderProfile::new("Fixture");
        profile.base_url = "http://catalog.invalid/v1".into();
        profile.api_key = "fixture".into();
        profile.upstream_proxy = "http://127.0.0.1:9".into();
        assert_eq!(
            crate::provider_models::fetch_with_proxy(&profile, &default, prepared.as_deref())
                .await
                .unwrap(),
            ["fixture-model"]
        );
        let official =
            crate::official_accounts::official_http_client(&default, None, prepared.as_deref())
                .unwrap();
        assert_eq!(
            official
                .get("http://catalog.invalid/usage")
                .send()
                .await
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap()["data"][0]["id"],
            "fixture-model"
        );
        serving.await.unwrap();
    }

    #[tokio::test]
    async fn selected_failures_never_resolve_to_legacy_or_reuse_disabled_nodes() {
        let store = Arc::new(MemorySecrets::default());
        let service = service(store.clone(), 2);
        let mut pool = NetworkProxyConfig {
            nodes: vec![node("selected", 1080)],
            ..Default::default()
        };
        let selection = ProxySelection::Node {
            id: "selected".into(),
        };
        assert!(
            service
                .prepare(&pool, &ProxySelection::Legacy)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            service
                .prepare(
                    &pool,
                    &ProxySelection::Node {
                        id: "missing".into()
                    }
                )
                .await
                .is_err()
        );
        let first = service.prepare(&pool, &selection).await.unwrap().unwrap();
        pool.nodes[0].name = "cosmetic change".into();
        assert_eq!(
            first.proxy_url(),
            service
                .prepare(&pool, &selection)
                .await
                .unwrap()
                .unwrap()
                .proxy_url()
        );
        pool.nodes[0].enabled = false;
        assert!(
            service
                .prepare(&pool, &selection)
                .await
                .unwrap_err()
                .contains("阻断")
        );
        pool.nodes[0].enabled = true;
        pool.nodes[0].credential_ref = Some(uuid::Uuid::new_v4().to_string());
        assert!(service.prepare(&pool, &selection).await.is_err());
        assert_eq!(store.reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn concurrent_preparation_coalesces_and_credential_rotation_creates_a_new_lease() {
        let store = Arc::new(MemorySecrets::default());
        let reference = uuid::Uuid::new_v4().to_string();
        store.values.lock().unwrap().insert(
            reference.clone(),
            ProxyCredential {
                username: "fixture".into(),
                password: "fixture-secret".into(),
            },
        );
        let service = service(store.clone(), 2);
        let mut proxy = node("selected", 1080);
        proxy.credential_ref = Some(reference);
        let mut pool = NetworkProxyConfig {
            nodes: vec![proxy],
            ..Default::default()
        };
        let selection = ProxySelection::Node {
            id: "selected".into(),
        };
        let (first, second) = tokio::join!(
            service.prepare(&pool, &selection),
            service.prepare(&pool, &selection)
        );
        let first = first.unwrap().unwrap();
        let second = second.unwrap().unwrap();
        assert_eq!(first.proxy_url(), second.proxy_url());
        assert_eq!(store.reads.load(Ordering::SeqCst), 1);
        let next = uuid::Uuid::new_v4().to_string();
        store.values.lock().unwrap().insert(
            next.clone(),
            ProxyCredential {
                username: "fixture".into(),
                password: "fixture-rotated".into(),
            },
        );
        pool.nodes[0].credential_ref = Some(next);
        let rotated = service.prepare(&pool, &selection).await.unwrap().unwrap();
        assert_ne!(first.proxy_url(), rotated.proxy_url());
        assert_eq!(store.reads.load(Ordering::SeqCst), 2);
        assert!(!rotated.proxy_url().contains("fixture"));
    }

    #[tokio::test]
    async fn cache_eviction_and_owner_drop_do_not_interrupt_a_held_stream_lease() {
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pool = NetworkProxyConfig {
            nodes: vec![
                node("first", proxy.local_addr().unwrap().port()),
                node("second", 1080),
            ],
            ..Default::default()
        };
        let service = service(Arc::new(MemorySecrets::default()), 1);
        let first = service
            .prepare(&pool, &ProxySelection::Node { id: "first".into() })
            .await
            .unwrap()
            .unwrap();
        let (continue_tx, continue_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = proxy.accept().await.unwrap();
            for reply in [
                b"HTTP/1.1 200 OK\r\n\r\n".as_slice(),
                b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\none",
            ] {
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(stream.read_u8().await.unwrap());
                }
                stream.write_all(reply).await.unwrap();
            }
            continue_rx.await.unwrap();
            stream.write_all(b"two").await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(first.proxy_url()).unwrap())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let mut response = client.get("http://target.invalid/").send().await.unwrap();
        assert_eq!(&response.chunk().await.unwrap().unwrap()[..], b"one");
        let second = service
            .prepare(
                &pool,
                &ProxySelection::Node {
                    id: "second".into(),
                },
            )
            .await
            .unwrap()
            .unwrap();
        drop(service);
        drop(second);
        continue_tx.send(()).unwrap();
        assert_eq!(response.text().await.unwrap(), "two");
        server.await.unwrap();
        drop(first);
    }
}
