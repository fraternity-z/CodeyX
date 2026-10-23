use crate::{ExtensionService, fsutil, mcp, transaction::Change};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use toml_edit::{DocumentMut, Item};

#[derive(Clone, Serialize, Deserialize)]
pub struct SharedMcpRegistration {
    pub registration_id: String,
    pub id: String,
    pub source_path: PathBuf,
    pub config: Value,
    pub max_instances: usize,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ManagedMcp {
    registration_id: String,
    id: String,
    source_path: PathBuf,
    original: String,
    generated: String,
    relay_executable: PathBuf,
    max_instances: usize,
}
pub(crate) type Registry = BTreeMap<String, ManagedMcp>;

// 独立文档保留表的注释、格式和未知 TOML 值，关闭共享时原样恢复。
fn document(id: &str, item: Item) -> Result<DocumentMut> {
    let mut doc = DocumentMut::new();
    doc["mcp_servers"] = Item::Table(toml_edit::Table::new());
    doc["mcp_servers"][id] = item;
    Ok(doc)
}
fn encoded(id: &str, item: Item) -> Result<String> {
    Ok(document(id, item)?.to_string())
}
fn replace(doc: &mut DocumentMut, id: &str, item: Item) -> Result<()> {
    doc["mcp_servers"]
        .as_table_like_mut()
        .context("MCP 表无效")?
        .insert(id, item);
    Ok(())
}
fn eligible(item: &Item) -> Result<()> {
    let config = mcp::object(item)?;
    mcp::validate_existing(&config)?;
    ensure!(
        config.get("command").and_then(Value::as_str).is_some() && config.get("url").is_none(),
        "共享实例仅支持本地 stdio MCP"
    );
    // 显式会话交互配置不能仅凭用户确认变成可共享服务。
    ensure!(
        ["subscriptions", "tasks", "sampling", "elicitation", "roots"]
            .iter()
            .all(|key| config.get(key).is_none()),
        "此 MCP 包含会话交互配置，请继续直连"
    );
    Ok(())
}

impl ExtensionService {
    pub fn logical_user_mcp_document(&self) -> Result<String> {
        let path = self.codex_home.join("config.toml");
        Ok(self
            .logical_mcp_document(&path, mcp::parse(fsutil::read(&path)?.as_deref())?)?
            .to_string())
    }

    /// The host supplies a reviewed built-in launch configuration; regular UI requests cannot select built-ins.
    pub fn synchronize_builtin_mcp(
        &self,
        id: &str,
        document: &str,
        revision: &str,
    ) -> Result<Value> {
        ensure!(
            matches!(id, "codey_fastctx" | "codey_codegraph"),
            "未知内置 MCP"
        );
        let config = mcp::object(&mcp::table(&mcp::parse(Some(document.as_bytes()))?, id)?)?;
        self.dispatch(json!({"action":"save_mcp","id":id,"configJson":config,"revision":revision,"confirmed":true,"builtinIds":[id]}))
    }

    pub(crate) fn shared_mcp_source_paths(&self) -> Result<Vec<PathBuf>> {
        Ok(self
            .shared_mcp_registry()?
            .values()
            .map(|m| m.source_path.clone())
            .collect())
    }
    pub(crate) fn mcp_scheduler_settings_path(&self) -> PathBuf {
        self.data_dir.join("mcp-sharing.json")
    }

    pub fn mcp_scheduler_enabled(&self) -> Result<bool> {
        fsutil::read(&self.mcp_scheduler_settings_path())?
            .map(|bytes| {
                serde_json::from_slice::<bool>(&bytes).context("MCP 共享器设置损坏，拒绝修改")
            })
            .unwrap_or_else(|| Ok(!self.shared_mcp_registry()?.is_empty()))
    }

    pub fn with_mcp_relay_executable(mut self, executable: PathBuf) -> Self {
        self.mcp_relay_executable = Some(executable);
        self
    }
    pub(crate) fn shared_mcp_path(&self) -> PathBuf {
        self.data_dir.join("managed-mcps.json")
    }
    pub(crate) fn shared_mcp_registry(&self) -> Result<Registry> {
        fsutil::read(&self.shared_mcp_path())?
            .map(|b| serde_json::from_slice(&b).context("托管 MCP 记录损坏，拒绝修改"))
            .unwrap_or_else(|| Ok(Default::default()))
    }
    pub(crate) fn logical_mcp_document(
        &self,
        path: &Path,
        mut doc: DocumentMut,
    ) -> Result<DocumentMut> {
        for managed in self
            .shared_mcp_registry()?
            .values()
            .filter(|m| m.source_path == path)
        {
            ensure!(
                encoded(&managed.id, mcp::table(&doc, &managed.id)?)? == managed.generated,
                "共享 MCP 配置已被外部修改，拒绝覆盖；请恢复原配置后重试"
            );
            replace(
                &mut doc,
                &managed.id,
                mcp::table(&mcp::parse(Some(managed.original.as_bytes()))?, &managed.id)?,
            )?;
        }
        Ok(doc)
    }
    pub(crate) fn mcp_sharing(&self, path: &Path, id: &str) -> Result<Value> {
        Ok(self.shared_mcp_registry()?.values().find(|m| m.source_path == path && m.id == id).map(|m| json!({"enabled":true,"maxInstances":m.max_instances,"registrationId":m.registration_id})).unwrap_or_else(|| json!({"enabled":false,"maxInstances":4})))
    }
    pub fn shared_mcp_registration(&self, registration_id: &str) -> Result<SharedMcpRegistration> {
        let managed = self
            .shared_mcp_registry()?
            .remove(registration_id)
            .context("共享 MCP 登记不存在")?;
        let doc = self.logical_mcp_document(
            &managed.source_path,
            mcp::parse(fsutil::read(&managed.source_path)?.as_deref())?,
        )?;
        let item = mcp::table(&doc, &managed.id)?;
        eligible(&item)?;
        ensure!(
            item.get("enabled").and_then(Item::as_bool).unwrap_or(true),
            "共享 MCP 已停用"
        );
        ensure!(
            (1..=8).contains(&managed.max_instances),
            "共享 MCP 实例上限无效"
        );
        Ok(SharedMcpRegistration {
            registration_id: managed.registration_id,
            id: managed.id,
            source_path: managed.source_path,
            config: mcp::object(&item)?,
            max_instances: managed.max_instances,
        })
    }
    pub(crate) fn set_mcp_sharing(
        &self,
        request: &Value,
        path: &Path,
        doc: &DocumentMut,
        registry: &mut Registry,
    ) -> Result<()> {
        let id = Self::required(request, "id")?;
        let item = mcp::table(doc, id)?;
        let enabled = request
            .get("enabled")
            .and_then(Value::as_bool)
            .context("缺少 enabled")?;
        let existing = registry
            .values()
            .find(|m| m.source_path == path && m.id == id)
            .map(|m| m.registration_id.clone());
        if !enabled {
            if let Some(key) = existing {
                registry.remove(&key);
            }
            return Ok(());
        }
        ensure!(
            request.get("confirmed").and_then(Value::as_bool) == Some(true),
            "请先确认此服务无会话状态且支持多实例运行"
        );
        eligible(&item)?;
        let max = request
            .get("maxInstances")
            .map(|v| v.as_u64().context("实例上限必须为整数"))
            .transpose()?
            .unwrap_or(4);
        ensure!((1..=8).contains(&max), "实例上限必须为 1 到 8");
        let executable = self
            .mcp_relay_executable
            .clone()
            .context("MCP 转发入口尚未配置")?;
        fsutil::safe_path(&executable)?;
        let key = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        registry.insert(
            key.clone(),
            ManagedMcp {
                registration_id: key,
                id: id.to_owned(),
                source_path: path.to_owned(),
                original: encoded(id, item)?,
                generated: String::new(),
                relay_executable: executable,
                max_instances: max as usize,
            },
        );
        Ok(())
    }
    pub(crate) fn prepare_shared_mcp_write(
        &self,
        path: &Path,
        doc: &mut DocumentMut,
        registry: &mut Registry,
        changes: &mut Vec<Change>,
    ) -> Result<()> {
        let enabled = self.mcp_scheduler_enabled()?;
        self.render_shared_mcp_write(path, doc, registry, enabled)?;
        if !self.mcp_scheduler_settings_path().exists() {
            changes.push(Change::new(
                self.mcp_scheduler_settings_path(),
                Some(serde_json::to_vec(&enabled)?),
            )?);
        }
        if !registry.is_empty() || self.shared_mcp_path().exists() {
            changes.push(Change::new(
                self.shared_mcp_path(),
                Some(serde_json::to_vec(registry)?),
            )?);
        }
        Ok(())
    }

    fn render_shared_mcp_write(
        &self,
        path: &Path,
        doc: &mut DocumentMut,
        registry: &mut Registry,
        enabled: bool,
    ) -> Result<()> {
        registry.retain(|_, m| m.source_path != path || mcp::table(doc, &m.id).is_ok());
        for managed in registry.values_mut().filter(|m| m.source_path == path) {
            let item = mcp::table(doc, &managed.id)?;
            eligible(&item)?;
            managed.original = encoded(&managed.id, item.clone())?;
            if !enabled {
                managed.generated = managed.original.clone();
                continue;
            }
            let mut relay = document(&managed.id, item)?;
            let table = relay["mcp_servers"][&managed.id]
                .as_table_like_mut()
                .context("MCP 配置必须为表")?;
            table.insert(
                "command",
                toml_edit::value(managed.relay_executable.to_string_lossy().as_ref()),
            );
            let args: toml_edit::Array = [
                "--mcp-relay".to_owned(),
                managed.registration_id.clone(),
                self.codex_home.to_string_lossy().into_owned(),
                self.data_dir.to_string_lossy().into_owned(),
                self.user_home.to_string_lossy().into_owned(),
            ]
            .into_iter()
            .collect();
            table.insert("args", toml_edit::value(args));
            let relay_item = mcp::table(&relay, &managed.id)?;
            managed.generated = encoded(&managed.id, relay_item.clone())?;
            replace(doc, &managed.id, relay_item)?;
        }
        Ok(())
    }

    pub(crate) fn prepare_scheduler_toggle(
        &self,
        request: &Value,
        changes: &mut Vec<Change>,
    ) -> Result<()> {
        let enabled = request["enabled"].as_bool().context("缺少 enabled")?;
        let mut registry = self.shared_mcp_registry()?;
        let mut paths: std::collections::BTreeSet<_> =
            registry.values().map(|m| m.source_path.clone()).collect();
        paths.insert(self.codex_home.join("config.toml"));
        for path in paths {
            let before = fsutil::read(&path)?;
            let mut doc = self.logical_mcp_document(&path, mcp::parse(before.as_deref())?)?;
            if enabled && path == self.codex_home.join("config.toml") {
                self.register_builtin_mcps(request, &path, &doc, &mut registry)?;
            }
            self.render_shared_mcp_write(&path, &mut doc, &mut registry, enabled)?;
            let after = doc.to_string().into_bytes();
            if before.as_deref().unwrap_or_default() != after {
                ensure!(fsutil::writable(&path), "MCP 配置文件或所在目录不可写");
                let mut change = Change::new(path, Some(after))?;
                // Compare against the bytes actually parsed, including other project scopes.
                change.before = before;
                changes.push(change);
            }
        }
        changes.push(Change::new(
            self.shared_mcp_path(),
            Some(serde_json::to_vec(&registry)?),
        )?);
        changes.push(Change::new(
            self.mcp_scheduler_settings_path(),
            Some(serde_json::to_vec(&enabled)?),
        )?);
        Ok(())
    }

    pub(crate) fn register_builtin_mcps(
        &self,
        request: &Value,
        path: &Path,
        doc: &DocumentMut,
        registry: &mut Registry,
    ) -> Result<()> {
        for id in request["builtinIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let Ok(item) = mcp::table(doc, id) else {
                continue;
            };
            if item.get("enabled").and_then(Item::as_bool) == Some(false)
                || registry
                    .values()
                    .any(|m| m.source_path == path && m.id == id)
            {
                continue;
            }
            self.set_mcp_sharing(
                &json!({"id":id,"enabled":true,"confirmed":true}),
                path,
                doc,
                registry,
            )?;
        }
        Ok(())
    }
}
