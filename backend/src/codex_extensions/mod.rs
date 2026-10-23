//! 宿主适配：系统路径由调用方注入，配置核心、凭证和协议检查分别维护。
mod probe;

use anyhow::{Context, Result, ensure};
use codey_codex_extensions::{ExtensionService, Scope};
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio::sync::Semaphore;

static REQUESTS: Semaphore = Semaphore::const_new(8);
static PROBES: Semaphore = Semaphore::const_new(2);

pub(crate) async fn dispatch(
    codex_home: PathBuf,
    data_dir: PathBuf,
    user_home: PathBuf,
    mut request: Value,
) -> Result<Value> {
    ensure!(data_dir.is_absolute(), "扩展数据目录必须为绝对路径");
    let permit = REQUESTS
        .try_acquire()
        .context("扩展管理请求过多，请稍后重试")?;
    request
        .as_object_mut()
        .context("扩展管理请求必须为对象")?
        .remove("builtinIds");
    let action = request
        .get("action")
        .and_then(Value::as_str)
        .context("缺少扩展管理操作")?;
    if action == "pick_project" || action == "pick_skill" {
        return pick_directory(action == "pick_project").await;
    }
    let builtin_root = data_dir
        .parent()
        .context("扩展数据目录无效")?
        .join("builtin-tools/codegraph");
    let service = ExtensionService::new(codex_home, data_dir, user_home)
        .with_mcp_relay_executable(std::env::current_exe().context("无法确定 MCP 转发程序路径")?);
    if action == "test_mcp" {
        let _probe = PROBES
            .try_acquire()
            .context("已有连接测试进行中，请稍后重试")?;
        // UI 的确认只针对当前看到的版本，过期配置不得在确认后执行。
        let (scope, id, revision) = probe_request(&request)?;
        let project_dir = match &scope {
            Scope::Project { project_path } => Some(project_path.clone()),
            Scope::User => None,
        };
        let config =
            tokio::task::spawn_blocking(move || prepare_probe(&service, &scope, &id, &revision))
                .await
                .context("读取 MCP 配置的任务异常退出")??;
        return Ok(probe::test_mcp(config, project_dir).await);
    }
    let needs_sharing_probe =
        action == "set_mcp_sharing" && request["enabled"] == true || action == "save_mcp";
    let service = if needs_sharing_probe {
        let candidate_request = request.clone();
        let (service, candidate, project_dir) = tokio::task::spawn_blocking(move || {
            let scope: Scope = serde_json::from_value(
                candidate_request
                    .get("scope")
                    .cloned()
                    .unwrap_or(json!({"kind":"user"})),
            )
            .context("MCP 作用域无效")?;
            let inventory = service.inventory(&scope)?;
            let id = candidate_request["id"].as_str().context("缺少 MCP 标识")?;
            let sharing = candidate_request["action"] == "set_mcp_sharing"
                || inventory["mcps"].as_array().is_some_and(|entries| {
                    entries
                        .iter()
                        .any(|entry| entry["id"] == id && entry["sharing"]["enabled"] == true)
                });
            let candidate = if sharing {
                ensure!(
                    candidate_request["confirmed"] == true,
                    "请先确认此服务无会话状态且支持多实例运行"
                );
                ensure!(
                    candidate_request["revision"] == inventory["revision"],
                    "配置已变化，请刷新并重新确认共享"
                );
                let config = if candidate_request["action"] == "save_mcp" {
                    service.mcp_save_configuration(&scope, id, &candidate_request["configJson"])?
                } else {
                    prepare_probe(
                        &service,
                        &scope,
                        id,
                        candidate_request["revision"]
                            .as_str()
                            .context("请刷新后重新确认共享")?,
                    )?
                };
                Some(config)
            } else {
                None
            };
            let project_dir = match scope {
                Scope::Project { project_path } => Some(project_path),
                Scope::User => None,
            };
            Ok::<_, anyhow::Error>((service, candidate, project_dir))
        })
        .await
        .context("读取共享 MCP 配置的任务异常退出")??;
        if let Some(config) = candidate {
            let _probe = PROBES
                .try_acquire()
                .context("已有连接测试进行中，请稍后重试")?;
            probe::validate_sharing(&config, project_dir).await?;
        }
        service
    } else {
        service
    };
    // 持有 permit 至阻塞任务完成，即使前端断开也让事务完成或自行恢复。
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if matches!(
            request["action"].as_str(),
            Some("set_mcp_scheduler_enabled" | "save_mcp" | "set_mcp_enabled" | "set_mcps_enabled")
        ) {
            let scope: Scope = if request["action"] == "set_mcp_scheduler_enabled" {
                Scope::User
            } else {
                serde_json::from_value(
                    request
                        .get("scope")
                        .cloned()
                        .unwrap_or(json!({"kind":"user"})),
                )?
            };
            if scope == Scope::User {
                let mut ids = Vec::new();
                for id in ["codey_fastctx", "codey_codegraph"] {
                    let config = if request["action"] == "save_mcp" && request["id"] == id {
                        Some(service.mcp_save_configuration(&scope, id, &request["configJson"])?)
                    } else {
                        service.mcp_configuration(&scope, id).ok()
                    };
                    if config
                        .as_ref()
                        .is_some_and(|config| builtin_mcp_is_managed(id, config, &builtin_root))
                    {
                        ids.push(id);
                    }
                }
                request["builtinIds"] = json!(ids);
            }
        }
        service.dispatch(request)
    })
    .await
    .context("扩展管理任务异常退出")?
}

fn builtin_mcp_is_managed(id: &str, config: &Value, builtin_root: &std::path::Path) -> bool {
    if id == "codey_fastctx" {
        return crate::codex_config::fastctx_server_command()
            .ok()
            .is_some_and(|command| {
                config["command"] == json!(command)
                    && config["args"] == json!(["--codey-fastctx-mcp"])
                    && config.get("cwd").is_none_or(Value::is_null)
            });
    }
    id == "codey_codegraph" && crate::codegraph_runtime::is_managed_mcp(config, builtin_root)
}

fn probe_request(request: &Value) -> Result<(Scope, String, String)> {
    ensure!(
        request.get("confirmed").and_then(Value::as_bool) == Some(true),
        "请先确认 MCP 连接测试"
    );
    let scope: Scope = serde_json::from_value(
        request
            .get("scope")
            .cloned()
            .unwrap_or(json!({"kind":"user"})),
    )
    .context("MCP 作用域无效")?;
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .context("缺少 MCP 标识")?;
    let revision = request
        .get("revision")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .context("请刷新后重新测试")?;
    Ok((scope, id.to_owned(), revision.to_owned()))
}

fn prepare_probe(
    service: &ExtensionService,
    scope: &Scope,
    id: &str,
    revision: &str,
) -> Result<Value> {
    ensure!(
        service.inventory(scope)?["revision"] == revision,
        "配置已变化，请刷新并重新确认测试"
    );
    let config = service.mcp_configuration(scope, id)?;
    ensure!(
        service.inventory(scope)?["revision"] == revision,
        "读取期间配置已变化，请重新确认测试"
    );
    Ok(config)
}

#[cfg(any(target_os = "macos", windows))]
async fn pick_directory(project: bool) -> Result<Value> {
    tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(if project {
                "选择项目目录"
            } else {
                "选择包含 SKILL.md 的目录"
            })
            .pick_folder()
            .map(|path| json!({"path":path}))
            .unwrap_or(Value::Null)
    })
    .await
    .context("目录选择器异常退出")
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn pick_directory(_: bool) -> Result<Value> {
    anyhow::bail!("当前平台请直接填写绝对路径")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_builtin_names_are_not_automatically_shared() {
        assert!(!builtin_mcp_is_managed(
            "codey_fastctx",
            &json!({"command":"custom","args":["--codey-fastctx-mcp"]}),
            std::path::Path::new("/trusted")
        ));
        assert!(!builtin_mcp_is_managed(
            "codey_codegraph",
            &json!({"command":"custom","args":["codegraph"]}),
            std::path::Path::new("/trusted")
        ));
        let directory = tempfile::tempdir().unwrap();
        let config = crate::codegraph_runtime::mcp_config(directory.path());
        assert!(builtin_mcp_is_managed(
            "codey_codegraph",
            &config,
            directory.path()
        ));
        assert!(!builtin_mcp_is_managed(
            "codey_codegraph",
            &config,
            &directory.path().join("other")
        ));
    }

    #[tokio::test]
    async fn sharing_preflight_requires_trusted_current_configuration_before_execution() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().canonicalize().unwrap();
        let data = home.join("data");
        let original = "[mcp_servers.demo]\ncommand='must-not-execute-fixture'\n";
        std::fs::write(home.join("config.toml"), original).unwrap();
        for request in [
            json!({"action":"set_mcp_sharing","id":"demo","enabled":true,"revision":"stale","confirmed":true}),
            json!({"action":"set_mcp_sharing","id":"demo","enabled":true,"revision":"stale"}),
        ] {
            let error = dispatch(home.clone(), data.clone(), home.clone(), request)
                .await
                .unwrap_err();
            assert!(!error.to_string().contains("无法启动"));
            assert_eq!(
                std::fs::read_to_string(home.join("config.toml")).unwrap(),
                original
            );
            assert!(!data.exists());
        }
    }

    #[tokio::test]
    async fn sharing_dispatch_probes_original_and_persists_relay() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().canonicalize().unwrap();
        let data = home.join("data");
        std::fs::write(
            home.join("config.toml"),
            format!(
                "[mcp_servers.demo]\ncommand='node'\nargs=['{}']\n",
                concat!(env!("CARGO_MANIFEST_DIR"), "/src/mcp_scheduler/fixture.cjs")
            ),
        )
        .unwrap();
        let service = ExtensionService::new(home.clone(), data.clone(), home.clone());
        let inventory = service.inventory(&Scope::User).unwrap();
        service.dispatch(json!({"action":"set_mcp_scheduler_enabled","enabled":true,"revision":inventory["revision"]})).unwrap();
        let inventory = service.inventory(&Scope::User).unwrap();
        let result = dispatch(home.clone(), data, home.clone(), json!({
            "action":"set_mcp_sharing","id":"demo","enabled":true,"confirmed":true,"revision":inventory["revision"]
        })).await.unwrap();
        assert_eq!(result["inventory"]["mcps"][0]["sharing"]["enabled"], true);
        assert!(
            std::fs::read_to_string(home.join("config.toml"))
                .unwrap()
                .contains("--mcp-relay")
        );
        assert_eq!(
            service.mcp_configuration(&Scope::User, "demo").unwrap()["command"],
            "node"
        );
        let persisted = std::fs::read(home.join("config.toml")).unwrap();
        let rejected = dispatch(home.clone(), home.join("data"), home.clone(), json!({
            "action":"save_mcp","id":"demo","confirmed":true,"revision":result["inventory"]["revision"],
            "configJson":{"command":"node","args":["-e", "require('readline').createInterface({input:process.stdin}).on('line',s=>{const r=JSON.parse(s);if(r.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:r.params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:'1'}}})+'\\n')})"]}
        })).await;
        assert!(rejected.is_err());
        assert_eq!(std::fs::read(home.join("config.toml")).unwrap(), persisted);
    }

    #[test]
    fn probes_require_confirmation_and_the_reviewed_revision() {
        assert!(probe_request(&json!({"id":"demo","revision":"v1"})).is_err());
        assert!(probe_request(&json!({"confirmed":true,"id":"demo"})).is_err());
        let root = tempfile::tempdir().unwrap();
        let home = root.path().canonicalize().unwrap();
        let config = home.join("config.toml");
        std::fs::write(&config, "[mcp_servers.demo]\ncommand = 'demo'\n").unwrap();
        let service = ExtensionService::new(home.clone(), home.join("data"), home.clone());
        let inventory = service.inventory(&Scope::User).unwrap();
        let revision = inventory["revision"].as_str().unwrap();
        assert_eq!(
            prepare_probe(&service, &Scope::User, "demo", revision).unwrap()["command"],
            "demo"
        );
        std::fs::write(config, "[mcp_servers.demo]\ncommand = 'changed'\n").unwrap();
        assert!(prepare_probe(&service, &Scope::User, "demo", revision).is_err());
        assert!(!home.join("data").exists());
    }
}
