<div align="center">

<h1>CodeyX</h1>

<p><strong>让 Codex 桌面端更顺手</strong></p>
<p>模型线路 · 多账号 · 会话管理 · 扩展与远程协作</p>

<p>
  <img src="https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square" alt="主要维护平台：Windows" />
  <img src="https://img.shields.io/badge/Codex-Desktop-24292F?style=flat-square" alt="Codex 桌面增强" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-2563EB?style=flat-square" alt="AGPL-3.0-only 许可" /></a>
</p>

<p>
  <a href="https://github.com/fraternity-z/CodeyX/releases/latest">下载最新版</a>
  · <a href="#主要功能">主要功能</a>
  · <a href="https://github.com/fraternity-z/CodeyX/issues">问题反馈</a>
</p>

</div>

CodeyX 是独立维护的 Codex 桌面增强启动器，将模型、账号、会话和扩展集中在一个控制台中管理。

> 当前主要面向 **Windows** 开发、测试与发布，其他平台不在维护范围内。

## 主要功能

| 能力 | 说明 |
| :--- | :--- |
| **线路与模型** | 管理官方及 Gemini 等第三方线路，在任务中切换模型与思考强度。 |
| **远程压缩** | 根据线路能力压缩上下文，支持跨线路继续对话。 |
| **多账号管理** | 管理多个 ChatGPT 账号、查看额度，并按需启用官方直连授权。 |
| **请求与用量** | 查看请求耗时、输出速度、Token 用量与错误分布。 |
| **会话管理** | 查看任务状态与数量，导入导出会话或删除指定轮次并恢复备份。 |
| **手机远程** | 通过局域网或 HTTPS 隧道在手机上继续电脑会话，支持发送照片。 |
| **扩展管理** | 统一管理 MCP、Skill 和可信原生插件。 |
| **插件线路** | 通过可信插件扩展模型线路、密钥轮换与账号接入。 |
| **页面增强** | 改善常用会话操作与插件市场体验，支持精选插件离线恢复。 |
| **桌面操作** | 可选安装 Codey Computer Use 工具，读取应用状态并执行点击、输入和滚动。 |
| **提示词优化** | 一键优化输入内容，优化结果可继续编辑。 |
| **对话 Git 提交** | 根据本对话改动生成中文提交说明，可选择仅提交或提交并推送。 |
| **模型分工** | 让子代理并行处理任务，并为不同角色选择模型与思考深度。 |
| **文件工具** | 可选启用 FastCtx，读取、搜索文件并批量替换内容。 |
| **任务通知** | 通过飞书、企业微信、Telegram、ntfy 或微信 ClawBot 接收任务状态通知。 |
| **诊断维护** | 检查和修复配置、恢复断线，并管理诊断日志与启动选项。 |
| **版本更新** | 检测稳定版与实验版更新，并在客户端阅读与发布页一致的完整公告。 |

## 使用须知

从 [Releases](https://github.com/fraternity-z/CodeyX/releases) 下载 Windows 安装包，安装后打开 CodeyX 即可启动 Codex，功能设置在 Codex 内的 Codey 控制台中完成。

- **客户端兼容**：仅支持可明确识别的 Codex 桌面客户端；启动可能重启客户端，请先结束任务，多版本共存时需明确选择。
- **账号与线路**：官方线路需添加官方账号，默认账号决定客户端登录身份，各线路使用各自账号。
- **服务商限制**：上下文预算不能扩大服务商容量，第三方能力及跨线路兼容性取决于服务商和 Codex 版本。
- **安装安全**：安装包和原生插件仅使用可信来源；原生插件拥有与 Codey 相同的系统权限，Codey 不修改客户端安全开关，集成失败后仅在确认清理完成时尝试原生启动。
- **桌面工具**：需先在 Codey 中手动准备，再到 Codex 安装启用。
- **远程访问**：需手动开启并配对，电脑须保持运行；局域网仅用于可信网络，临时隧道经过 Cloudflare 且地址会变化，设备授权可随时撤销。
- **更新选择**：“不检查”仅关闭自动检查，仍可手动检查稳定版；实验版需主动启用，使用前请备份重要数据。

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
