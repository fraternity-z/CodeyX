use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;

use super::{AppState, current_fast_context_tools_status, redacted_config};
use crate::network_proxy::{
    NetworkProxyConfig,
    egress::prepare_hops,
    model::ProxySelection,
    probe,
    secrets::{CredentialUpdate, SystemSecretStore, save_with_credentials},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveInput {
    settings_revision: u64,
    config: NetworkProxyConfig,
    #[serde(default)]
    credentials: Vec<CredentialUpdate>,
}

pub(super) async fn invoke(
    state: &Arc<AppState>,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    match command {
        "network_proxy_get" => {
            let config = state.config.read().await.clone();
            Ok(snapshot(state, &config).await)
        }
        "network_proxy_save" => {
            let input: SaveInput =
                serde_json::from_value(args.clone()).map_err(|_| "网络代理配置格式无效")?;
            save(state, input).await
        }
        "network_proxy_test" | "network_proxy_test_chain" => {
            static LIMIT: OnceLock<Semaphore> = OnceLock::new();
            let _permit = LIMIT
                .get_or_init(|| Semaphore::new(4))
                .try_acquire()
                .map_err(|_| "同时测试的代理过多，请稍后重试")?;
            let chain_test = command == "network_proxy_test_chain";
            let id = args
                .get(if chain_test { "chainId" } else { "nodeId" })
                .and_then(Value::as_str)
                .ok_or("缺少代理节点或链路 ID")?;
            let pool = state.config.read().await.network_proxy.clone();
            let selection = if chain_test {
                ProxySelection::Chain { id: id.into() }
            } else {
                ProxySelection::Node { id: id.into() }
            };
            let nodes = pool.test_nodes(&selection)?;
            let snapshot_nodes = nodes.clone();
            let path = state.store.path().to_path_buf();
            let mut hops =
                prepare_hops(nodes, Arc::new(SystemSecretStore::for_config(&path))).await?;
            if chain_test {
                let chain = pool
                    .chains
                    .iter()
                    .find(|chain| chain.id == id)
                    .ok_or("代理链路不存在")?;
                let result = probe::test_chain(id, hops).await?;
                Ok(json!({ "chain": chain, "nodes": snapshot_nodes, "result": result }))
            } else {
                let hop = hops.pop().ok_or("代理节点不存在")?;
                let result = probe::test_node(&hop.node, hop.credential).await?;
                Ok(json!({ "node": hop.node, "result": result }))
            }
        }
        _ => Err("未知网络代理命令".into()),
    }
}

async fn snapshot(state: &Arc<AppState>, config: &crate::config::CodeyConfig) -> Value {
    json!({
        "config": redacted_config(config),
        "fastContextToolsStatus": current_fast_context_tools_status(),
        "probeUrl": probe::EXIT_PROBE_URL,
        "launchProxyPoolSupported": crate::codex_config::runtime_router_platform_supported(),
        "trafficCaptureSupported": cfg!(all(windows, target_arch = "x86_64")),
        "trafficCaptureAvailable": capture_available(),
        "restartRequired": super::runtime_config_requires_restart(state, config).await,
    })
}

fn capture_available() -> bool {
    #[cfg(windows)]
    {
        crate::network_proxy::process_capture::available()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

async fn save(state: &Arc<AppState>, input: SaveInput) -> Result<Value, String> {
    let _guard = state.config_write_lock.lock().await;
    if state.config_load_error.is_some() {
        return Err("现有配置未能完整读取，请先恢复配置；代理设置未写入".into());
    }
    let previous = state.config.read().await.clone();
    if previous.settings_revision != input.settings_revision {
        return Err("设置已被其他操作更新，请刷新后再保存；当前代理草稿已保留".into());
    }
    let mut validated = previous.clone();
    validated.network_proxy = input.config.clone();
    validated.validate_network_proxy()?;
    if (input.config.process_proxy != previous.network_proxy.process_proxy
        || input.config.process_capture != previous.network_proxy.process_capture)
        && input.config.has_process_proxy()
    {
        if !crate::codex_config::runtime_router_platform_supported() {
            return Err("当前宿主暂不支持从代理池启动 Codex".into());
        }
        input
            .config
            .validate_active_selection(&input.config.process_proxy)?;
    }
    if input.config.process_capture
        && !previous.network_proxy.process_capture
        && !cfg!(all(windows, target_arch = "x86_64"))
    {
        return Err("当前宿主暂不支持流量接管".into());
    }
    for (profile_id, selection) in &input.config.upstream_by_profile {
        if matches!(selection, ProxySelection::Legacy)
            || previous.network_proxy.upstream_by_profile.get(profile_id) == Some(selection)
        {
            continue;
        }
        if !previous
            .profiles
            .iter()
            .any(|profile| &profile.id == profile_id)
        {
            return Err("线路当前不可用，不能新增它的代理池出口；已有选择仍保留".into());
        }
        input.config.validate_active_selection(selection)?;
    }
    let store = state.store.clone();
    let saved = tokio::task::spawn_blocking(move || {
        let secret_store = SystemSecretStore::for_config(store.path());
        let mut next = previous.clone();
        next.settings_revision = previous
            .settings_revision
            .checked_add(1)
            .ok_or("配置版本已达到上限")?;
        save_with_credentials(
            &previous.network_proxy,
            input.config,
            input.credentials,
            &secret_store,
            |pool| {
                next.network_proxy = pool;
                store
                    .persist(next)
                    .map_err(|_| "代理配置未能保存，请检查磁盘空间和文件权限".into())
            },
        )
    })
    .await
    .map_err(|_| "代理配置保存任务异常退出，请刷新后确认保存结果")??;
    {
        let mut config = state.config.write().await;
        *config = saved.clone();
        if let Some(egress) = state.network_proxy_egress.get() {
            egress.configure(saved.network_proxy.clone());
        }
    }
    Ok(snapshot(state, &saved).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CodeyConfig, ConfigStore};

    #[tokio::test]
    async fn policy_direct_requires_consent_before_commit_and_bindings_survive_disable() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("config.json"));
        let config = CodeyConfig::default();
        let profile = config.profiles[0].id.clone();
        store.save(&config).unwrap();
        let original = std::fs::read(store.path()).unwrap();
        let state = Arc::new(AppState {
            store: store.clone(),
            config: tokio::sync::RwLock::new(config),
            config_load_error: None,
            ..Default::default()
        });
        let mut pool = json!({"policies":[{"id":"work","name":"Work","enabled":true,"defaultAction":{"kind":"direct"}}],
            "upstreamByProfile":{(profile.clone()):{"kind":"policy","id":"work"}}});
        assert!(
            invoke(
                &state,
                "network_proxy_save",
                &json!({"settingsRevision":0,"config":pool})
            )
            .await
            .unwrap_err()
            .contains("显式允许")
        );
        assert_eq!(std::fs::read(store.path()).unwrap(), original);
        pool["policies"][0]["allowDirect"] = json!(true);
        invoke(
            &state,
            "network_proxy_save",
            &json!({"settingsRevision":0,"config":pool}),
        )
        .await
        .unwrap();
        let service = state.network_proxy_egress().await;
        assert!(service.for_profile(&profile).await.unwrap().is_some());
        pool["policies"][0]["enabled"] = json!(false);
        invoke(
            &state,
            "network_proxy_save",
            &json!({"settingsRevision":1,"config":pool}),
        )
        .await
        .unwrap();
        assert!(service.for_profile(&profile).await.is_err());
        pool["policies"] = json!([]);
        assert!(
            invoke(
                &state,
                "network_proxy_save",
                &json!({"settingsRevision":2,"config":pool})
            )
            .await
            .is_err()
        );
        assert_eq!(store.load().unwrap().settings_revision, 2);
    }

    #[tokio::test]
    async fn network_proxy_bindings_publish_after_commit_and_prevent_unsafe_mode_changes() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("config.json"));
        let config = CodeyConfig::default();
        let profile_id = config.profiles[0].id.clone();
        store.save(&config).unwrap();
        let state = Arc::new(AppState {
            store: store.clone(),
            config: tokio::sync::RwLock::new(config),
            config_load_error: None,
            ..Default::default()
        });
        let egress = state.network_proxy_egress().await;
        let pool = json!({"schemaVersion":1, "nodes":[{
            "id":"exit", "name":"Exit", "endpoint":{"protocol":"socks5", "host":"127.0.0.1", "port":1080, "dns":"remote"},
            "enabled":true, "credentialRef":null, "notes":"", "tags":[], "group":""
        }], "chains":[], "upstreamByProfile":{(profile_id.clone()):{"kind":"node", "id":"exit"}}});
        invoke(
            &state,
            "network_proxy_save",
            &json!({"settingsRevision":0,"config":pool}),
        )
        .await
        .unwrap();
        assert!(egress.for_profile(&profile_id).await.unwrap().is_some());
        let mut stored = store.load().unwrap();
        stored.local_router_enabled = false;
        let bytes = std::fs::read(store.path()).unwrap();
        assert!(
            store
                .persist(stored)
                .unwrap_err()
                .to_string()
                .contains("本地路由")
        );
        assert_eq!(std::fs::read(store.path()).unwrap(), bytes);
        let mut disabled = pool.clone();
        disabled["nodes"][0]["enabled"] = json!(false);
        invoke(
            &state,
            "network_proxy_save",
            &json!({"settingsRevision":1,"config":disabled}),
        )
        .await
        .unwrap();
        assert!(egress.for_profile(&profile_id).await.is_err());
        assert_eq!(
            store
                .load()
                .unwrap()
                .network_proxy
                .upstream_by_profile
                .len(),
            1
        );
        let mut deleted = disabled;
        deleted["nodes"] = json!([]);
        assert!(
            invoke(
                &state,
                "network_proxy_save",
                &json!({"settingsRevision":2,"config":deleted})
            )
            .await
            .is_err()
        );
        assert_eq!(store.load().unwrap().settings_revision, 2);
        assert!(egress.for_profile(&profile_id).await.is_err());
    }

    #[tokio::test]
    async fn pool_save_preserves_legacy_proxy_and_rejects_stale_revision() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("config.json"));
        let config = CodeyConfig {
            codex_launch_proxy: "socks5://127.0.0.1:1080".into(),
            ..Default::default()
        };
        store.save(&config).unwrap();
        let state = Arc::new(AppState {
            store: store.clone(),
            config: tokio::sync::RwLock::new(config),
            config_load_error: None,
            ..Default::default()
        });
        let args = json!({"settingsRevision": 0, "config": NetworkProxyConfig::default()});
        let result = invoke(&state, "network_proxy_save", &args).await.unwrap();
        assert_eq!(result["config"]["settingsRevision"], 1);
        assert_eq!(
            store.load().unwrap().codex_launch_proxy,
            "socks5://127.0.0.1:1080"
        );
        assert!(
            invoke(&state, "network_proxy_save", &args)
                .await
                .unwrap_err()
                .contains("更新")
        );
        assert_eq!(store.load().unwrap().settings_revision, 1);
    }

    #[tokio::test]
    async fn unknown_schema_preserves_original_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("config.json"));
        let config = CodeyConfig::default();
        store.save(&config).unwrap();
        let bytes = std::fs::read(store.path()).unwrap();
        let state = Arc::new(AppState {
            store: store.clone(),
            config: tokio::sync::RwLock::new(config),
            config_load_error: None,
            ..Default::default()
        });
        assert!(
            invoke(
                &state,
                "network_proxy_save",
                &json!({"settingsRevision": 0, "config": {"schemaVersion": 99}})
            )
            .await
            .is_err()
        );
        assert_eq!(std::fs::read(store.path()).unwrap(), bytes);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[tokio::test]
    async fn process_selection_is_independent_and_disabled_selection_never_clears_itself() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("config.json"));
        let config = CodeyConfig {
            local_router_enabled: false,
            codex_launch_proxy: "http://127.0.0.1:7890".into(),
            ..Default::default()
        };
        store.save(&config).unwrap();
        let state = Arc::new(AppState {
            store: store.clone(),
            config: tokio::sync::RwLock::new(config),
            config_load_error: None,
            ..Default::default()
        });
        let mut pool = json!({"schemaVersion":1,"nodes":[{
            "id":"exit", "name":"Exit", "endpoint":{"protocol":"socks5","host":"proxy.invalid","port":1080},
            "enabled":false
        }],"processProxy":{"kind":"node","id":"exit"}});
        assert!(
            invoke(
                &state,
                "network_proxy_save",
                &json!({"settingsRevision":0,"config":pool})
            )
            .await
            .unwrap_err()
            .contains("禁用")
        );
        assert_eq!(store.load().unwrap().settings_revision, 0);
        pool["nodes"][0]["enabled"] = json!(true);
        let saved = invoke(
            &state,
            "network_proxy_save",
            &json!({"settingsRevision":0,"config":pool}),
        )
        .await
        .unwrap();
        assert_eq!(saved["launchProxyPoolSupported"], true);
        assert_eq!(saved["restartRequired"], false);
        assert_eq!(saved["config"]["codexLaunchProxy"], "http://127.0.0.1:7890");
        assert!(
            store
                .load()
                .unwrap()
                .network_proxy
                .upstream_by_profile
                .is_empty()
        );
        pool["nodes"][0]["enabled"] = json!(false);
        invoke(
            &state,
            "network_proxy_save",
            &json!({"settingsRevision":1,"config":pool}),
        )
        .await
        .unwrap();
        let disabled = store.load().unwrap();
        assert!(disabled.network_proxy.has_process_proxy());
        assert!(
            disabled
                .network_proxy
                .resolve(&disabled.network_proxy.process_proxy)
                .is_err()
        );
        pool["nodes"] = json!([]);
        assert!(
            invoke(
                &state,
                "network_proxy_save",
                &json!({"settingsRevision":2,"config":pool})
            )
            .await
            .is_err()
        );
        assert_eq!(store.load().unwrap().settings_revision, 2);
        pool["processProxy"] = json!({"kind":"legacy"});
        invoke(
            &state,
            "network_proxy_save",
            &json!({"settingsRevision":2,"config":pool}),
        )
        .await
        .unwrap();
        assert!(!store.load().unwrap().network_proxy.has_process_proxy());
    }

    #[tokio::test]
    async fn network_proxy_recovered_backup_is_reviewable_but_cannot_authorize_network_or_overwrite_source()
     {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("config.json"));
        let original = CodeyConfig::default();
        store.save(&original).unwrap();
        let mut newer = original.clone();
        newer.codex_launch_proxy = "http://127.0.0.1:7890".into();
        store.save(&newer).unwrap();
        let broken = b"{broken-source-with-private-fixture";
        std::fs::write(store.path(), broken).unwrap();
        let (recovered, warning) = super::super::load_config_or_defaults(&store);
        assert_eq!(recovered, original.normalize());
        let warning = warning.expect("a backup cannot silently authorize its older network policy");
        assert!(warning.contains("已加载备份供检查"));
        assert!(!warning.contains("private-fixture"));
        assert_eq!(std::fs::read(store.path()).unwrap(), broken);
        let state = Arc::new(AppState {
            store: store.clone(),
            config: tokio::sync::RwLock::new(recovered),
            config_load_error: Some(warning),
            ..Default::default()
        });
        let service = state.network_proxy_egress().await;
        for legacy in [None, Some("http://127.0.0.1:9")] {
            assert!(
                service
                    .proxy_for_profile("route", legacy, false)
                    .await
                    .err()
                    .expect("recovered configuration must block networking")
                    .contains("连接已暂停")
            );
        }
        service.configure(NetworkProxyConfig::default());
        assert!(service.for_profile("route").await.is_err());
        assert!(!super::super::ensure_default_route_imported(&state).await);
        assert!(
            invoke(
                &state,
                "network_proxy_save",
                &json!({"settingsRevision":0,"config":NetworkProxyConfig::default()})
            )
            .await
            .is_err()
        );
        assert_eq!(std::fs::read(store.path()).unwrap(), broken);
        assert!(
            store
                .preserve_unreadable()
                .iter()
                .any(|path| std::fs::read(path).is_ok_and(|bytes| bytes == broken))
        );
    }
}
