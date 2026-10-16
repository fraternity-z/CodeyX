use std::path::Path;
use std::process::Command;
mod build_computer_use;

fn main() {
    build_computer_use::build();
    for path in [
        "../src",
        "../vite.overlay.config.ts",
        "../vite.remote.config.ts",
        "../package.json",
        "../pnpm-lock.yaml",
        "../pnpm-workspace.yaml",
        "../patches",
        "../tsconfig.json",
        "../.gitignore",
        "icons/Codey.ico",
        "../scripts/build-overlay.mjs",
        "../scripts/build-output.mjs",
        "../scripts/overlay-build-cache.mjs",
        "../public",
        "../dist-overlay",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }

    // 构建入口或发布检查先准备前端产物后，传入此标记避免重复调用。
    // 直接运行 Cargo 时，前端脚本也会按输入和产物摘要复用已有构建。
    // include_str! 会把 dist-overlay 下的文件登记进 dep-info，跳过时改动产物
    // 仍会触发重新编译。
    println!("cargo:rerun-if-env-changed=CODEY_SKIP_OVERLAY_BUILD");
    if std::env::var_os("CODEY_SKIP_OVERLAY_BUILD").is_some_and(|value| value == "1") {
        assert!(
            Path::new("../dist-overlay/codey-overlay.js").is_file(),
            "CODEY_SKIP_OVERLAY_BUILD=1 但 dist-overlay/codey-overlay.js 不存在，请先运行 pnpm run vite:build"
        );
        assert!(
            Path::new("../dist-overlay/codey-remote.js").is_file()
                && Path::new("../dist-overlay/codey-remote.css").is_file(),
            "远程页面资源不存在，请先运行 pnpm run vite:build"
        );
    } else {
        match Command::new("node")
            .arg("scripts/build-overlay.mjs")
            .current_dir(Path::new(".."))
            .status()
        {
            Err(error) => panic!(
                "无法运行 Node.js 构建 Codey 配置页：{error}。请先安装 Node.js，并在仓库根目录执行 pnpm install"
            ),
            Ok(status) if !status.success() => panic!(
                "Codey 配置页构建失败（退出码 {}）。请在仓库根目录执行 pnpm install 后重试",
                status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "未知".to_string())
            ),
            Ok(_) => {}
        }
    }

    #[cfg(windows)]
    embed_windows_icon();
}

#[cfg(windows)]
fn embed_windows_icon() {
    let mut resource = winres::WindowsResource::new();
    resource
        .set("ProductName", "CodeyX")
        .set("FileDescription", "CodeyX");
    resource.set_icon("icons/Codey.ico").set_manifest(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>"#,
    );
    resource.compile().expect("无法嵌入 Codey Windows 图标");
}
