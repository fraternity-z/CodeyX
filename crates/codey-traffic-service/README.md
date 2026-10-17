# Codex 流量接管服务验证包

该组件把一个 Windows Job 中的进程及其后代的 TCP 连接转交给 CodeyX 已有的本地 SOCKS5 入口，由现有代理池决定出口和链路。捕获使用原版 WinDivert，TCP/IP 使用固定提交的 mitmproxy Rust 引擎；不安装证书、不解密 TLS，不设置系统代理或路由。

当前是供集成验证的 Windows x64 服务，已接入网络代理页面的显式开关与桌面启动流程，尚未完成实际驱动加载和 Codex 接管验证。不要将本地自动测试通过当作透明接管已经验收。macOS 和 Linux 继续使用已有代理功能。

捕获部分通过可选的 `capture` feature 单独构建，普通工作区构建不依赖 WinDivert DLL。各会话使用独立 Job、控制管道和本地出口，共用原版驱动；最多保留 16 个不同的捕获优先级，转发后继续经过后续会话。多实例的分配与停止已通过离线测试，实际数据包隔离仍需下面的原生验证。

## 本地验证与复现

解压后运行 `powershell -NoProfile -File .\verify.ps1`。它校验包内文件、运行本地测试并检查服务版本，不加载驱动、不启动捕获、不改动运行中的 Codex。驱动的 Authenticode 状态与实际内核加载是否成功是不同结果。

从当前 CodeyX 源码仓库检出 `manifest.json` 中的 `sourceCommit`，将 `source-overlay` 中的文件复制到该检出目录，然后运行：

```powershell
$env:PYTHONUTF8 = '1'
python scripts/build-traffic-service.py --desktop
```

需要 Python 3.11+、Rust 1.95+、MSVC C++ 构建工具和网络；包含桌面程序时还需 Node.js，并先用仓库指定的 pnpm 执行 `pnpm install --frozen-lockfile`。首次构建从 Cargo.lock 固定的源获取依赖；打包脚本验证 WinDivert 的固定 SHA-256，不编译或修改驱动。每次生成新目录和 ZIP，不覆盖以前的包。包中含服务、测试程序、自动测试结果、源码覆盖文件和许可证；`--desktop` 同时包含 `codey.exe` 和桌面离线测试程序，省略该参数只构建服务。

在独立测试环境保留 `codey.exe`、`codey-traffic-service.exe`、`WinDivert.dll` 和 `WinDivert64.sys` 同目录。网络代理页面先保存并启用代理池节点，再打开“选择 Codex 启动出口”，选择节点或链路并勾选“启用实验性 TCP 流量接管”。保存不会启动组件；下次通过 CodeyX 启动 Codex 时才请求 UAC 授权。取消授权、缺失组件或绑定失败均停止启动；关闭接管后仍保留所选代理池出口，重启后回到兼容接入。此包不安装到现有客户端，也不包含用户配置或凭据。

界面回归在源码目录运行 `pnpm exec playwright install chromium` 后执行 `pnpm exec playwright test tests/browser/network-proxy.spec.mjs`。大型构建目录导致开发服务器响应缓慢时，可先设置 `$env:CODEY_BROWSER_STATIC = '1'`，使用预构建的同一模拟页面；这不会启动接管组件或访问真实代理。

## 独立环境的实际接管验证

在 Windows 10/11 x64 测试虚拟机的管理员终端运行：

```powershell
.\traffic-probe.exe --live
```

该命令会加载包内 WinDivert，创建两个临时本地模拟代理，只把它自己创建的测试子进程放入各自 Job，不扫描或终止真实 Codex。测试目标使用保留的文档地址，不需要真实代理密码；验证并行根进程、后代、不同出口、范围外进程，以及停止一个会话后另一个仍能连接。测试期间需要可用的 IPv4 默认路由，但不会创建或修改路由。未执行该命令时，包清单始终标记实际接管为 `not-run`。

还需在该环境验证 IPv6、长连接、休眠恢复、权限不足、驱动被安全软件拒绝、网卡切换、端口复用和服务强制终止；核对不在 Job 内的浏览器、DNS 与本地服务持续可用。测试失败保留输出，不关闭证书校验或安全软件来绕过问题。

## 集成与边界

- 启动器创建私有 Job 和命名管道，先启动服务并完成双方 PID 核验；收到 `Ready` 后，才将暂停的 Codex 根进程加入 Job 并恢复线程。普通启动和共享 app-server 使用暂停创建；Store 启动助手完成身份核验后请求控制器绑定，再恢复主线程，激活调用尚未返回时也能处理绑定。后代由 Windows 自动继承，禁止 breakaway；系统代理服务另行创建的进程不自动纳入。每次启动使用独立 UUID。
- 上游凭据继续由 CodeyX 保管；服务只通过本地私有管道收到短期本地入口凭据，命令行仅含会话 ID 和控制进程 PID。服务没有直接连接目标的回退分支。
- CodeyX 的进程代理入口同时接受认证 HTTP 和 SOCKS5，每条新连接重新检查当前代理池；禁用出口会阻断新连接，已建立的流继续使用原出口。该入口的回归可在应用源码运行 `cargo test -p codey --lib --locked network_proxy::process_gateway`，并设置 `NO_PROXY=127.0.0.1,localhost,::1`。
- 正常停止、控制通道断开或转发组件错误时，先停止本次 Job 的客户进程，再释放捕获。客户端监视服务退出并停止本次 Job，不能无代理重新启动 Codex。强制杀死服务后的检测延迟可能产生窗口，尚未证明零泄漏，不能宣称完全防泄漏。
- TCP 内容透明转发，目标 TLS 验证由原应用完成；支持 IPv4/IPv6 目标地址。UDP/QUIC 不转发，匹配范围内的 UDP 丢弃，应用可自行改用 TCP；不会因此自动直连。
- 已由 Windows DNS Client 代为发送的系统 DNS 不能可靠归属到单个 Job，本服务不会接管 `svchost.exe`。已有应用代理的远端解析继续使用；其他应用内 DNS 与特殊 IPv6 扩展头、原始套接字需要单独验证，当前不提供 DNS 无泄漏保证。
- 这是用户态接管服务；打开 WinDivert 时会由现有组件按需加载其驱动，仅在显式启用后通过 UAC 请求管理员授权，没有开机服务或全局网络开关。应使用可信的完整验证包；本机组件存在性检查不证明发布者身份。

## 第三方来源

mitmproxy Rust 引擎固定到 `51fe2b7c5aa8439c162abb665db61c6669d146d6`（MIT）；进程与数据包关联方式参考其 Windows redirector（LGPL-3.0-or-later），本服务使用 Job 精确归属和独立控制协议。WinDivert 与 Rust FFI 绑定采用 LGPL-3.0-or-later，驱动、DLL 保持原样。完整许可随包提供；来源分别为 <https://github.com/mitmproxy/mitmproxy_rs>、<https://github.com/basil00/WinDivert>、<https://github.com/Rubensei/windivert-rust>。这些项目没有为 CodeyX 的修改提供背书。
