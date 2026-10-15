---
name: codey-plugin-creator
description: Create, extend, package, and validate trusted native Codey Rust plugins using codey-plugin-sdk and the .codey-plugin format. Use for plugin implementation, configuration templates, request lifecycle or provider integrations, and local packaging; not for Codex marketplace plugins or UI-only extensions.
metadata:
  short-description: 快速创建 Codey 原生插件
---

# Codey 原生插件开发

生成可编译、打包和验证的 Rust `cdylib` 插件，遵循仓库 [AGENTS](../../../AGENTS.md)。插件拥有宿主系统权限，只处理可信代码；`.codey-plugin` 与 Codex marketplace 的 `.codex-plugin/plugin.json` 是不同格式，目标不明时先查看仓库，再作必要澄清。

## 协议入口

先读 [SDK](../../../crates/codey-plugin-sdk/README.md)，按能力加载对应协议，不在本技能另存协议副本：

| 需求 | 参考与边界 |
| --- | --- |
| 普通管理方法、配置、数据与日志 | SDK；不需要额外 capability，未知方法返回错误。 |
| 请求头、等待、重发、认证或账号状态 | [生命周期协议](../../../crates/codey-plugin-sdk/REQUEST_LIFECYCLE.md)；基础能力为 `request.lifecycle.v1`，敏感动作分别授权，不能用普通头修改认证。 |
| 登记线路与模型 | SDK 的 `provider.route.v1`；普通线路密钥由用户填写。 |
| 自定义传输与账号接入 | 完整阅读[传输协议](../../../crates/codey-plugin-sdk/PROVIDER_TRANSPORT.md)，同时声明线路、传输与账号能力。 |
| 任务数量 | SDK 的 app-server 协议；能力声明不授予路由令牌，不能虚构连接或认证来源。 |

## 开发流程

1. 确认平台、架构、ID、版本、能力和配置字段，检查已有实现。本地插件只在仓库 `plugins/` 下开发，源码、配置与产物不提交 Git；SDK、模板和 Skill 保留版本控制。
2. 使用本技能的 `scripts/create_codey_plugin.py` 生成 crate，或增量修改已有插件。默认拒绝覆盖文件，只有用户明确授权覆盖才使用 `--force`。
3. 实现 `Plugin::create`、`Plugin::invoke` 并用 `export_plugin!` 导出；初始化校验业务配置，仅声明已实现的能力，管理方法不能冒充宿主专用回调。
4. 使用 `PluginContext.data_dir` 保存有界业务状态，`context.log` 写必要日志；不记录凭据、认证上下文或请求正文。确需保存协议历史时按账号隔离、限制容量与保留时间，并说明敏感参数和卸载保留风险。
5. 运行插件的格式化、格式检查、`cargo check` 和相关测试，再用仓库 `scripts/package-plugin.py` 打包；具体构建与交付命令见 [SDK](../../../crates/codey-plugin-sdk/README.md#本地开发与交付)。
6. 校验包只含 manifest、配置模板和入口库，确认平台、架构、ABI、SHA-256 与配置规则匹配；安装仅检查文件，用户启用后才加载。

从仓库根目录生成最小插件：

```sh
python .agents/skills/codey-plugin-creator/scripts/create_codey_plugin.py my-plugin --path plugins/my-plugin --display-name "我的插件" --capability request.lifecycle.v1
```

脚手架生成独立 `[workspace]`，默认 SDK 路径按脚本所属仓库计算；`--sdk-path` 可覆盖。脚手架生命周期默认继续，传输占位明确失败，业务未实现前不能作为可用插件交付。

## 验证与交付

- 配置为严格 JSON 对象，可用 `_comments` 说明字段；宿主传入插件前移除。离线用 `config::validate` 检查格式，已连接桥接可用 `get_codey_plugin_host_info` 和 `validate_codey_plugin_config` 预检查；格式通过不等于业务有效或已获权限。
- 回调及时返回，后台任务在实例销毁前停止；宿主不能隔离原生死循环、段错误或进程退出。变更业务配置需重新启用，升级或默认卸载保留数据和日志。
- 交付前分别检查 macOS、Windows 工具链并构建；不能实际构建的平台说明限制和可复现命令，不把检查通过当作构建完成。仅调整规范时不创建业务插件或安装包。
- 安装包放入当前用户实际桌面的插件名称目录，文件名区分平台、架构和版本，同名另取新名，不覆盖已有产物；摘要只证明完整性，不证明发布者身份。
- 交付说明源码与产物位置、支持平台、启用方式及实际运行的检查。仅在用户授权的目标渠道发布、签名或分发，默认交付本地可验证安装包。
