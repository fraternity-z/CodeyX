<div align="center">

<h1>CodeyX</h1>

<p>模型线路 · 多账号 · 会话管理 · 扩展与远程协作</p>

<p>
  <img src="https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square" alt="主要维护平台：Windows" />
  <img src="https://img.shields.io/badge/Codex-Desktop-24292F?style=flat-square" alt="Codex 桌面增强" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-2563EB?style=flat-square" alt="AGPL-3.0-only 许可" /></a>
</p>

<p>
  <a href="https://github.com/fraternity-z/CodeyX/releases/latest">下载最新版</a>
  · <a href="#界面预览">界面预览</a>
  · <a href="#开始使用">开始使用</a>
  · <a href="#主要功能">主要功能</a>
  · <a href="#使用须知">使用须知</a>
  · <a href="https://github.com/fraternity-z/CodeyX/issues">问题反馈</a>
</p>

</div>

CodeyX 是独立维护的 Codex 桌面增强启动器，将模型、账号、会话和扩展集中在一个控制台中管理。

> 当前主要面向 **Windows** 开发、测试与发布，其他平台不在维护范围内。

## 界面预览

在 Codex 内打开 CodeyX 控制台，集中管理线路、账号、会话与扩展。

![CodeyX 模型线路管理界面，展示线路与模型设置](docs/images/model-routes.png)

> 截图使用演示数据，具体界面与可用能力以安装版本为准。

<details>
<summary>查看更多：请求日志、子代理与手机远程</summary>

### 请求日志

按线路、模型和状态查看请求，了解耗时、输出速度与 Token 用量。

![CodeyX 请求日志界面，展示请求筛选与用量信息](docs/images/request-logs.png)

### 子代理分工

为不同任务配置子代理角色、读写能力、模型与思考深度。

![CodeyX 子代理配置界面，展示角色与权限设置](docs/images/subagents.png)

### 手机远程

在手机上继续电脑会话，查看任务进展并发送文字或照片。

<p align="center">
  <img src="docs/images/remote-mobile.png" width="360" alt="CodeyX 手机远程界面，展示会话与消息输入" />
</p>

</details>

## 开始使用

1. 从 [Releases](https://github.com/fraternity-z/CodeyX/releases/latest) 下载 Windows 安装包，查看对应版本的发布说明。
2. 安装并打开 CodeyX，由 CodeyX 启动已安装的 Codex 桌面客户端。
3. 在 Codex 内打开 CodeyX 控制台，添加官方账号或第三方线路，选择要使用的模型。

首次启动前请先结束正在运行的任务；客户端兼容、凭据保存和远程访问的边界见[使用须知](#使用须知)。

## 主要功能

### 线路与账号

| 能力 | 说明 |
| :--- | :--- |
| **线路与模型** | 管理官方及 Gemini 等第三方线路，支持 New API 连接串快速导入，在任务中切换模型与思考强度。 |
| **多账号管理** | 管理多个 ChatGPT 账号、查看额度，并按需启用官方直连授权。 |
| **远程压缩** | 根据线路能力压缩上下文，支持跨线路继续对话。 |
| **网络代理** | 管理 Codex 进程代理和线路代理，通过开关选用代理池节点并检测出口。 |

### 会话与协作

| 能力 | 说明 |
| :--- | :--- |
| **会话管理** | 查看任务状态、导入导出与恢复备份，支持永久清理本机会话及归档。 |
| **手机远程** | 通过局域网或 HTTPS 隧道在手机上继续电脑会话，支持发送照片。 |
| **提示词优化** | 一键优化输入内容，优化结果可继续编辑。 |
| **对话 Git 提交** | 根据本对话改动生成中文提交说明，可选择仅提交或提交并推送。 |
| **模型分工** | 支持内置与自定义子代理，可配置读写能力、并发数量、模型与思考深度。 |

### 扩展与工具

| 能力 | 说明 |
| :--- | :--- |
| **扩展管理** | 管理 MCP、Skill 和可信原生插件，通过插件扩展线路、密钥轮换与账号接入。 |
| **MCP 共享** | 可选启用共享器，统一管理内置工具及兼容 MCP 的进程，支持并发调度和释放空闲实例；有状态服务保持直连。 |
| **页面增强** | 改善常用会话操作与插件市场体验，支持精选插件离线恢复。 |
| **桌面操作** | 可选安装 CodeyX Computer Use 工具，读取应用状态并执行点击、输入和滚动。 |
| **内置工具** | 管理 FastCtx 文件检索、仅为工作区已添加本地项目自动建库并同步的 CodeGraph，以及可选自动安装和配置默认模式的 Ponytail 插件。 |

### 备份、观测与维护

| 能力 | 说明 |
| :--- | :--- |
| **配置备份** | 在独立页面导入导出 JSON 配置，支持 WebDAV 云备份与确认恢复。 |
| **请求与用量** | 查看请求耗时、输出速度、Token 用量与错误分布，并在对话状态条查看会话轮数、最近一轮活动及缓存命中率。 |
| **任务通知** | 通过飞书、企业微信、Telegram、ntfy 或微信 ClawBot 接收任务状态通知。 |
| **诊断维护** | 检查和修复配置、恢复断线，并管理诊断日志与启动选项。 |
| **版本更新** | 按需开启稳定版更新检查、阅读完整公告，并在系统设置中选择 GitHub 官方源或 GH-Proxy 下载安装包。 |

## 使用须知

### 客户端与模型兼容

- **客户端兼容**：仅支持可明确识别的 Codex 桌面客户端；启动可能重启客户端，请先结束任务，多版本共存时需明确选择。
- **WSL 模式（实验性）**：支持 Windows 客户端配合 WSL 后端运行，需启用 Windows 程序互操作，兼容性仍在验证中。
- **服务商限制**：上下文预算不能扩大服务商容量，第三方能力及跨线路兼容性取决于服务商和 Codex 版本。
- **更新选择**：“不更新”仅关闭自动检查，仍可手动检查稳定版。

### 数据与凭据

- **会话清理**：永久清理无法撤销，需通过 CodeyX 重启 Codex 完成；不处理项目文件、云端会话或用户另存的导出与备份。
- **账号与线路**：官方线路需添加官方账号，默认账号决定客户端登录身份；既有手填代理凭据、第三方密钥及部分通知凭据以明文保存在本地私有配置和备份中，请妥善保管。
- **配置恢复**：恢复前自动保留当前配置，保留本机账号、插件线路、代理池和路径；JSON 含明文密钥，WebDAV 默认使用 HTTPS，会话与扩展文件需单独备份。

### 网络与远程访问

- **网络接入**：默认启动代理依赖程序遵守代理设置；Windows 实验性流量接管需另备组件并授权管理员权限，尚不保证系统 DNS 与异常退出时无泄漏；代理池凭据使用系统密钥库，出口检测会联系第三方，线路代理关闭时沿用原有网络设置。
- **远程访问**：需手动开启并配对，电脑须保持运行；局域网仅用于可信网络，临时隧道经过 Cloudflare 且地址会变化，设备授权可随时撤销。

### 安装与扩展权限

- **安装安全**：安装包和原生插件仅使用可信来源；原生插件拥有与 CodeyX 相同的系统权限，CodeyX 不修改客户端安全开关，集成失败后仅在确认清理完成时尝试原生启动。
- **桌面工具**：需先在 CodeyX 中手动准备，再到 Codex 安装启用。

## 文档与反馈

| 入口 | 内容 |
| :--- | :--- |
| [版本发布](https://github.com/fraternity-z/CodeyX/releases) | 安装包、版本变化与升级说明。 |
| [问题反馈](https://github.com/fraternity-z/CodeyX/issues) | 报告使用问题或提出功能建议。 |
| [内部开发文档](INTERNAL_DEVELOPMENT.md) | 面向维护者的核心流程、依赖与兼容边界。 |
| [架构分层规范](ARCHITECTURE.md) | 参与开发时的职责、依赖与状态约束。 |
| [插件 SDK](crates/codey-plugin-sdk/README.md) | 可信原生插件的开发入口与协议契约。 |
| [第三方声明](THIRD_PARTY_NOTICES.md) | 第三方资源的版权、许可与必要声明。 |

反馈问题时请附上 CodeyX 与 Codex 版本、复现步骤和错误现象，避免提交密钥或完整私有配置。

## 来源与许可

CodeyX 基于 [SuperGness/Codey](https://github.com/SuperGness/codey) 独立维护，由 fraternity-z 继续开发，与上游无官方隶属或背书关系；问题请反馈至本仓库。

本项目沿用 [AGPL-3.0-only](LICENSE) 许可，保留上游版权与必要的[第三方声明](THIRD_PARTY_NOTICES.md)。

<details>
<summary>FastCtx 第三方声明（Apache-2.0）</summary>

    This product includes FastCtx
    (https://github.com/yc-duan/fastctx), Copyright (c) 2026 yc-duan,
    used under the Apache License 2.0.

    FastCtx is redistributed and/or modified here by the maintainer of
    this distribution. Any such change is that maintainer's own work
    and their sole responsibility. It is not endorsed by, not
    supported by, and not attributable to the author of FastCtx, who
    accepts no liability of any kind arising from this distribution or
    from anything built on top of it.

</details>
