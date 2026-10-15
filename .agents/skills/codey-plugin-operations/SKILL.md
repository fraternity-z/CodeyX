---
name: codey-plugin-operations
description: Inspect, configure, enable, invoke, and troubleshoot trusted native Codey plugins through the existing Codey bridge. Use for installed .codey-plugin packages and native plugin management; use codey-plugin-creator for implementation and packaging, and do not apply this skill to Codex marketplace plugins.
---

# Codey 原生插件调用

通过已连接的 Codey 控制台桥接管理可信原生插件；插件拥有宿主系统权限。本技能不提供 CLI、MCP 或认证，没有桥接时使用控制台或说明限制，不虚构调用入口。配置和协议契约见 [SDK](../../../crates/codey-plugin-sdk/README.md)，开发交付见[创建 Skill](../codey-plugin-creator/SKILL.md)。

## 管理接口

仓库前端通过 [src/api.ts](../../../src/api.ts) 的 `invoke(command, args)` 调用 `window.__codeyInvokeApi`，参数为 JSON 对象；后端见 [native_plugins.rs](../../../backend/src/commands/native_plugins.rs)。

| 命令 | 参数 | 结果 |
| --- | --- | --- |
| `get_codey_plugin_host_info` | 无 | `{abiVersion, platform, arch, acceptedCapabilities, limits}`，静态协议与限制，不含配置、路径或凭据 |
| `validate_codey_plugin_config` | `{content}` | `{valid, byteLength, maxBytes, error}`，只做内存格式检查，不保存或调用插件 |
| `list_codey_plugins` | 无 | `{plugins, platform, arch}`，含状态、能力、活动版本、配置及日志路径 |
| `select_codey_plugin_package` | 无 | macOS / Windows 文件选择器返回包检查结果，取消时返回 `null` |
| `inspect_codey_plugin` | `{path}` | `{path, sha256, manifest}`，只检查包，不加载库 |
| `install_codey_plugin` | `{path, sha256}` | 更新后的插件列表，摘要来自刚取得的检查结果 |
| `set_codey_plugin_enabled` | `{pluginId, enabled}` | 更新后的插件列表，启用时才加载库 |
| `get_codey_plugin_config_file` | `{pluginId}` | `{pluginId, version, path, content, sha256}` |
| `save_codey_plugin_config_file` | `{pluginId, content, expectedSha256}` | 更新后的插件列表，使用读取时的配置摘要 |
| `invoke_codey_plugin` | `{pluginId, method, params?}` | 插件自定义 JSON 结果；省略参数时插件收到 `null` |
| `open_codey_plugin_directory` | `{pluginId}` | `{status:"ok"}`，打开文件管理器 |
| `open_codey_plugin_logs` | `{pluginId}` | `{status:"ok"}` 或 `{status:"already_open"}` |
| `clear_codey_plugin_logs` | `{pluginId, confirmed:true}` | 更新后的插件列表；先取得用户清理授权 |
| `uninstall_codey_plugin` | `{pluginId, removeData?:false}` | 更新后的插件列表；清理数据须明确授权 |

拖拽上传由控制台的有界暂存流程处理，`inspect_codey_plugin` 也接受内部 `upload` 或 `discardUpload` 参数；不要自行拼接上传对象，复用已有控制台实现。

## 配置、权限与错误

- 配置和诊断格式遵循 [SDK](../../../crates/codey-plugin-sdk/README.md#配置规则)。先读取 `content` 与 `sha256`，保留原字段修改，再用原摘要作为 `expectedSha256` 保存；格式通过不代表业务有效，业务参数修改后需重新启用。
- 两个预检查接口不依赖已安装插件，能力名单不代表授权，Vite 预览会拒绝查询；离线格式检查使用 SDK 的 `config::validate`。
- 管理接口拒绝生命周期回调、`provider.describe` 和 `provider.request.*`。生命周期、线路及传输能力由宿主调度；可调用的业务方法须由插件自己的文档或代码确认，不能假设所有插件都有 `ping`。
- 任务数量另走 [SDK 的 app-server 协议](../../../crates/codey-plugin-sdk/README.md#能力与调用边界)，不混用管理桥接令牌与路由令牌，能力声明不提供连接或凭据。
- `invoke` 将后端 `{status:"failed", message}` 转为 `CodeyApiError`。配置摘要冲突时重新读取并合并用户修改；包摘要变化时重新检查，启用失败时读取 `lastError` 及日志。调用结果不明时先查询状态，避免重复安装、启停或删除。
- 卸载默认保留配置、数据和日志；原生后台执行可能阻止卸载，Windows 已加载库可能需退出 Codey 后清理。不得擅自清除用户数据或记录凭据。

## 调用示例

以下 TypeScript 在已有 Codey 前端模块中使用；先确认安装与启用已在用户授权范围内：

```ts
import { invoke } from "./api";
import type { CodeyPluginHostInfo, CodeyPluginConfigValidation } from "./codeyPlugins";

const host = await invoke<CodeyPluginHostInfo>("get_codey_plugin_host_info");
const report = await invoke<CodeyPluginConfigValidation>(
  "validate_codey_plugin_config", {content: '{"enabled":true}'});
if (!report.valid) throw new Error(report.error?.message ?? "配置格式无效");

const checked = await invoke<{path: string; sha256: string}>(
  "inspect_codey_plugin", {path: "/path/demo.codey-plugin"});
await invoke("install_codey_plugin", checked);
await invoke("set_codey_plugin_enabled", {pluginId: "dev.codey.demo", enabled: true});
// 仅在该插件实现了 health 方法时调用。
const health = await invoke("invoke_codey_plugin", {
  pluginId: "dev.codey.demo", method: "health", params: {},
});
```
