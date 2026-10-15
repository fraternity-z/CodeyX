# AGENTS.md

## 本地插件约束

- 所有本地插件均在仓库根目录的 `plugins/` 下开发；本地插件源码、配置和构建产物不得提交到 Git，也不得使用强制添加绕过忽略规则。
- 不得为了落实此约束删除或改写已有用户数据；已被跟踪的内容应先说明情况，再按用户授权处理。
- SDK、源码模板、Skill 和公共文档应纳入版本控制；不得扩大忽略范围使这些资源被排除。
- 开发并交付具体插件时，先检查 macOS 和 Windows 的构建工具链并分别构建；无法实际构建的平台须说明限制并提供可复现命令，不得将检查通过视为构建完成。
- 安装包放入当前用户实际桌面目录下以插件名称命名的文件夹，缺失时创建；文件名区分平台、架构与版本，同名已存在时使用新文件名，不覆盖已有产物。开发规范调整本身不要求创建业务插件或安装包。

## 文档分层与维护

| 入口 | 职责 |
| --- | --- |
| [README](README.md) | 面向使用者的主要能力、使用须知与来源声明。 |
| [内部开发文档](INTERNAL_DEVELOPMENT.md) | 面向维护者的核心流程、依赖及安全与兼容边界。 |
| 本文件 | 仓库约束、验证与发布约定。 |
| [插件 SDK](crates/codey-plugin-sdk/README.md) | 插件开发入口及协议契约；Skill 引用这里，不另存协议副本。 |
| [发布公告](releases/) | 按版本保存公告，格式见 [模板](releases/TEMPLATE.md)。 |
| [第三方声明](THIRD_PARTY_NOTICES.md) | 版权、许可与必须保留的原文。 |

- 使用简短、自然的中文，每项说明一项能力或一个核心机制。README 每项原则上一句话，不写构建发布步骤、依赖版本、端口、协议、数据结构、内部路径或实现细节。
- 内部文档按模块概括实现；字段、参数和精确行为由代码、测试及 SDK 协议承载，不记录界面布局、逐步回退或单次兼容修复过程。
- 功能变化时改写已有段落，合并重复、删除过时内容；修复缺陷不自动增加篇幅。README 和内部文档不作更新日志，不保留验收记录、性能测量或待实施方案，历史交由 Git 保存。
- 只保留影响功能选择、核心实现理解或风险判断的信息，不把删去的细节搬到另一份概述。安全限制、数据存储风险及第三方声明不得因精简而删除。
- 完成后通读相关文档，检查导航与相对链接，避免重复维护；仅新增独立主要能力或必要边界时增加条目。

## 验证约定

- 插件脚本测试需 Python 3.11 及以上；Windows 上设置 `PYTHONUTF8=1` 后运行 `python -m unittest discover -s scripts -p "test_*plugin.py"`，避免子进程的 UTF-8 输出按 GBK 解码。
- `AppState::default()` 会读取本机配置；依赖特定配置的测试应显式初始化 `config`，不能只替换 `store`。
- 运行依赖本地 HTTP mock 的 Rust 测试时，在测试进程中设置 `NO_PROXY=127.0.0.1,localhost,::1`，避免继承的代理改写回环请求；不要改动系统代理。
- 验证 Codex 桌面兼容性时，以运行中 `runtime_status` 返回的 `codexAppVersion` 为准；Windows 卸载登记的 `DisplayVersion` 可能滞后，不能据此判断实际运行版本。
- 更新公告回归运行 `node --test tests/release-notes*.test.mjs tests/app-updates.test.mjs tests/native-update-ui.test.mjs tests/release-quality-gates.test.mjs`；后端运行 `cargo test -p codey --lib --locked update`，保留上述回环代理设置。
- 更新弹窗浏览器验证先运行 `pnpm run vite:dev`，打开 `/codey/tests/ui-browser.html?view=update&state=markdown`，用 Playwright CLI 的 `run-code --filename tests/release-notes-browser.playwright.js` 检查明暗主题、Shadow DOM、窄屏、滚动及键盘交互。
- Windows 调试程序占用构建产物时，将 `CARGO_TARGET_DIR` 和 `CARGO_BUILD_BUILD_DIR` 同时设为独立验证目录，避免替换运行中的程序或复用被占用的中间产物；不要强制结束用户的客户端。

## 发布公告

- 每个版本使用 `releases/v<version>.md`，按 `releases/TEMPLATE.md` 编写；首行 `# CodeyX v<version> · 版本主题` 用作 Release 标题，其余内容为正文。只描述已经核实的版本差异，替换占位符并删除无内容的分类，图片优先使用固定版本的 HTTPS 地址。
- 发布前运行 `node scripts/release-notes.mjs <version>` 校验公告；普通标签工作流只生成草稿，审核公告和安装包后再公开，不自动覆盖已发布版本。
