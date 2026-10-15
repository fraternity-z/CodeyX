# Codey Plugin SDK

用于开发 CodeyX 可信原生 Rust 插件，与 Codex 插件市场独立。插件编译为 `cdylib`，实现 `Plugin::create` 和 `Plugin::invoke`，通过 `export_plugin!` 导出 `codey_plugin_entry_v1`；动态库边界使用 ABI v1 的 C 布局函数表，返回内存由插件释放。

| 文档 | 用途 |
| --- | --- |
| 本文 | 开发入口、安装包、配置与存储约定。 |
| [请求生命周期](REQUEST_LIFECYCLE.md) | 发送前、响应头、等待、重试及终态事件。 |
| [供应商传输](PROVIDER_TRANSPORT.md) | 自定义上游、账号绑定、分块传输与清理。 |
| [创建 Skill](../../.agents/skills/codey-plugin-creator/SKILL.md) / [管理 Skill](../../.agents/skills/codey-plugin-operations/SKILL.md) | 创建交付流程与现有管理桥接的调用。 |

## 安装与实例

`.codey-plugin` 是 ZIP，包含根目录 `manifest.json`、`config.json` 和入口动态库，打包器将动态库放在 `lib/`。每个包只对应一个平台与架构：平台为 `macos`、`windows` 或 `linux`，架构使用 Rust 名称，如 `aarch64`、`x86_64`。

manifest 包含 ID、名称、semver 版本、ABI 版本、平台、架构、入口、库 SHA-256 和能力声明。ID 最长 96 字符，以小写字母开头，只含小写字母、数字及 `._-`，禁止连续点和末尾点；入口必须是安全的包内相对路径。哈希由打包器计算，只证明完整性，不证明发布者身份。

导入只检查文件，启用后才加载；实例固定配置与权限，变更后需重新启用或重启。宿主串行调用同一实例，回调应及时返回，后台任务须在销毁前停止。SDK 与宿主将 ABI 入口的 panic 转为错误，但无法隔离段错误、死循环或进程退出，能力声明不构成沙箱。

## 配置与持久数据

每个插件位于用户状态目录的 `codey-plugins/installed/<plugin-id>/`：制品存于 `versions/<version-uuid>/`，运行配置为 `config.json`，业务数据和日志分别存于 `data/`、`logs/`。首次安装复制模板，升级保留已有配置；卸载默认保留配置、数据和日志，明确选择清理才删除。活动实例阻止卸载，库映射保留至进程退出，Windows 可能需退出后才能删除 DLL。

`Plugin::create(config, context)` 接收配置和必填的 `PluginContext`，包含 `plugin_id` 及绝对路径 `plugin_dir`、`data_dir`、`log_dir`。ABI 初始化对象仅接受 `config` 和 `context`，后者使用 camelCase 字段；宿主不改变全进程工作目录或环境变量。

### 配置规则

- `config.json` 是不超过 1 MiB 的严格 UTF-8 JSON 对象，不支持 JSONC。模板定义默认值，插件初始化验证业务约束，不提供配置 schema 或 HTML 配置页。
- 任意对象层级可有 `_comments` 对象，其值必须是说明字符串；宿主校验后递归移除，其他下划线字段和字符串不受影响。说明优先按同级字段名匹配，再查祖先的点分路径，数组省略下标；同名含点键优先，有歧义时在嵌套对象内声明。
- 编辑器按模板编辑值并保留原文，保存校验内容摘要；新增字段、改变结构或修复无效文件需外部编辑后重载。只改说明无需重新启用，业务参数变化需重新启用。配置在用户私有目录中明文保存，没有独立密钥存储。
- 离线用 `config::validate(text)` 检查格式，用 `config::parse(text)` 获取移除说明的配置；两者不写文件、不加载插件、不验证业务。`ConfigError` 含详细字段路径，不应直接用于需要隐藏配置键名的诊断输出。

### 数据与日志

业务数据使用 `context.data_dir` 下固定文件名，自行限制大小、处理并发并原子更新。目录约定不是文件系统沙箱，保存请求历史时须说明敏感参数及卸载保留风险，不持久化凭据。

`context.log` 写 `logs/plugin.log`，宿主事件写 `logs/host.log`；各保留当前文件及一个备份，每文件最多 1 MiB，单条最多 4096 字节。helper 用共享文件锁协调写入与轮转，不重建缺失目录；所有写入方须遵守该约定，锁失败由调用者决定忽略或重试。只记录必要事件，不在请求成功时频繁同步写日志，不写入配置、凭据或正文。

## 能力与调用边界

| 能力 | 用途与限制 |
| --- | --- |
| 无额外能力 | 自定义管理方法，通过 `invoke_codey_plugin` 调用。 |
| `request.lifecycle.v1` | 受限头修改、等待、重发和终止；认证上下文、API Key 选择及借用账号状态分别额外授权，详见[生命周期协议](REQUEST_LIFECYCLE.md)。 |
| `provider.route.v1` | 启用时通过 `provider.describe` 登记线路，普通线路的密钥由用户填写。 |
| `provider.transport.v1` + `provider.account.v1` | 与线路能力一起声明，自行适配上游并使用邮箱绑定账号，详见[传输协议](PROVIDER_TRANSPORT.md)。 |
| `appserver.call.v1` | 兼容声明，不授予网络或管理权限；SDK 只提供任务查询协议类型。 |

`provider.describe` 返回 `name`、`baseUrl`、`upstreamProtocol`、1–32 个 `models` 和可选 `headers`。名称最多 15 字符，协议为 `openaiResponses`、`openaiChatCompletions` 或 `anthropicMessages`，头部不能携带密钥。可选 `modelReasoningEfforts` 将模型 ID 映射到思考档位上限，用户不能通过自定义取值启用未声明的档位；旧宿主可能拒绝未知字段。

管理接口拒绝生命周期事件、`provider.describe` 和整个 `provider.request.*` 前缀，防止伪造宿主调度。任务数量另通过本地路由 `POST /codey/api/appserver` 提交 `Request::get_tasks()` JSON，携带路由 Bearer token；校验响应 schema 和 error 后读取 `TaskCounts`。`PluginContext` 不提供地址或令牌，SDK 不发网络请求，未列入 [schema](schema/appserver.v1.json) 的调用不会执行。

## 宿主预检查

以下命令通过已有 Codey 管理桥接调用，不依赖已安装插件，不加载动态库；SDK 不提供桥接连接或认证。

| 命令 | 输入 | 输出 |
| --- | --- | --- |
| `get_codey_plugin_host_info` | `{}` | `host::HostInfo`：ABI、平台、架构、接受的能力和大小限制。 |
| `validate_codey_plugin_config` | `{content: string}` | `config::ValidationResult`：格式是否有效、字节数、上限与错误。 |

能力名单不代表授权，返回值不含路径、插件列表、配置或凭据。格式错误正常返回 `valid:false`，错误码为 `too_large`、`invalid_json`、`invalid_root`、`invalid_comments_object` 或 `invalid_comment_value`；语法错误可带从 1 开始的行号和字节列号，不回传业务字段或原始错误。参数类型错误沿用桥接错误，Vite 预览拒绝调用；检查通过后保存仍需摘要校验，业务规则仍由插件验证。调用示例见[管理 Skill](../../.agents/skills/codey-plugin-operations/SKILL.md)。

## 本地开发与交付

本地插件在仓库 `plugins/` 下开发，源码、配置与产物不提交 Git；SDK、模板和 Skill 保留版本控制。仓库不包含可直接交付的业务插件，脚手架只提供最小实现。以下命令在仓库根目录运行，Python 需 3.11 以上：

```sh
python .agents/skills/codey-plugin-creator/scripts/create_codey_plugin.py header-demo --path plugins/header-demo --capability request.lifecycle.v1
cargo fmt --manifest-path plugins/header-demo/Cargo.toml --check
cargo test --manifest-path plugins/header-demo/Cargo.toml
```

先检查 `rustup target list --installed` 及目标链接器。分别在具备对应工具链的 Windows 和 macOS 上构建：

```sh
cargo build --manifest-path plugins/header-demo/Cargo.toml --release --target x86_64-pc-windows-msvc --target-dir plugins/header-demo/target
cargo build --manifest-path plugins/header-demo/Cargo.toml --release --target aarch64-apple-darwin --target-dir plugins/header-demo/target
```

Windows 已配置 MinGW 时可改用 `x86_64-pc-windows-gnu`，并设置 `CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER`；macOS 需要 Apple 工具链。只有 Rust target 不代表可以链接，编译成功也不代表已在目标宿主验证运行。

Windows 打包示例（先将输出路径替换为当前用户的实际桌面目录）：

```sh
python scripts/package-plugin.py --library plugins/header-demo/target/x86_64-pc-windows-msvc/release/codey_plugin_header_demo.dll --config plugins/header-demo/config.json --output "<实际桌面>/header-demo/header-demo-windows-x86_64-0.1.0.codey-plugin" --id dev.codey.header-demo --name header-demo --version 0.1.0 --platform windows --arch x86_64 --capability request.lifecycle.v1
```

macOS 使用 `aarch64-apple-darwin/release/libcodey_plugin_header_demo.dylib`，并匹配平台、架构和文件名；Linux 库后缀为 `.so`。打包器不执行交叉编译，省略 `--config` 会写空模板，不覆盖已有输出。交付文件放入实际桌面的插件名称目录，文件名包含平台、架构和版本，同名时另取新名；无法构建的平台须说明限制并提供命令，不能把工具链检查当作构建完成。
