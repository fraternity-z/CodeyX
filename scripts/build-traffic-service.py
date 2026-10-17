#!/usr/bin/env python3
"""Build and package the Windows capture service without loading its driver."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import uuid
import zipfile


ENGINE_REVISION = "51fe2b7c5aa8439c162abb665db61c6669d146d6"
COMPONENT_HASHES = {
    "WinDivert.dll": "c1e060ee19444a259b2162f8af0f3fe8c4428a1c6f694dce20de194ac8d7d9a2",
    "WinDivert.lib": "c5678d544eb0121a189d1139f54e0c67854dc64d1c897111a27ef2e52cb38eb3",
    "WinDivert64.sys": "8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2",
}
SOURCE_FILES = (
    "Cargo.toml", "Cargo.lock", "THIRD_PARTY_NOTICES.md", "README.md", "INTERNAL_DEVELOPMENT.md",
    "scripts/build-traffic-service.py", "scripts/verify-traffic-service.ps1", "scripts/test_traffic_service.py",
    "scripts/browser-test-server.mjs", "playwright.config.mjs",
    "backend/Cargo.toml", "backend/src/appserver_call.rs", "backend/src/commands.rs",
    "backend/src/commands/network_proxy.rs", "backend/src/commands/restart_tests.rs",
    "backend/src/launch_proxy.rs", "backend/src/launcher.rs", "backend/src/launcher/platform.rs",
    "backend/src/launcher/process.rs", "backend/src/launcher/recovery.rs", "backend/src/launcher/windows_packaged.rs",
    "backend/src/network_proxy/gateway.rs", "backend/src/network_proxy/mod.rs",
    "backend/src/network_proxy/model.rs", "backend/src/network_proxy/model/tests.rs",
    "backend/src/network_proxy/process_gateway.rs", "backend/src/network_proxy/process_gateway_tests.rs",
    "backend/src/network_proxy/process_capture.rs",
    "src/features/network-proxy/ProcessProxySelection.tsx", "src/features/network-proxy/NetworkProxyPage.tsx",
    "src/features/network-proxy/process.ts", "src/features/network-proxy/types.ts",
    "src/features/network-proxy/useNetworkProxyController.ts", "src/dev/mockApi.ts",
    "tests/network-proxy.test.mjs", "tests/codex-launch-proxy.test.mjs", "tests/browser/network-proxy.spec.mjs",
)
DESKTOP_TEST_FILTERS = ("network_proxy", "launcher::windows_packaged", "launch_proxy", "appserver_call")


def sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def validate_components(directory):
    for name, expected in COMPONENT_HASHES.items():
        path = directory / name
        if not path.is_file() or path.is_symlink() or sha256(path) != expected:
            raise ValueError(f"捕获组件校验失败：{name}；拒绝使用其他来源的驱动或 DLL")


def run(arguments, root, env, timeout=1200):
    result = subprocess.run(arguments, cwd=root, env=env, text=True, encoding="utf-8",
                            errors="replace", capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        print(result.stdout)
        print(result.stderr)
        raise RuntimeError(f"命令失败，退出码 {result.returncode}：{arguments[0]}")
    return result


def artifacts(output):
    found = {}
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("reason") == "compiler-artifact" and event.get("executable"):
            target = event["target"]
            is_library_test = event.get("profile", {}).get("test") and bool({"lib", "rlib"}.intersection(target["kind"]))
            key = "unit-tests" if is_library_test else target["name"]
            found[key] = Path(event["executable"])
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", action="store_true")
    parser.add_argument("--desktop", action="store_true", help="同时构建带启动接线的桌面程序和离线测试")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error("需要 Python 3.11 或以上版本；请使用对应 Python 执行该脚本")
    if platform.system() != "Windows" or platform.machine().lower() not in {"amd64", "x86_64"}:
        parser.error("此验证包需要 Windows x64、Python 3.11+ 和 Rust 1.95+ MSVC 工具链")
    root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env["NO_PROXY"] = "127.0.0.1,localhost,::1"
    env["CARGO_TARGET_DIR"] = str(root / "target/network-proxy-validation")
    env["CARGO_BUILD_BUILD_DIR"] = str(root / "target/network-proxy-validation/build")
    env["PYTHONUTF8"] = "1"
    metadata = json.loads(run(["cargo", "metadata", "--features", "codey-traffic-service/capture", "--locked", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc"], root, env).stdout)
    engine = next(p for p in metadata["packages"] if p["name"] == "mitmproxy" and ENGINE_REVISION in (p.get("source") or ""))
    engine_root = Path(engine["manifest_path"]).parent
    component = engine_root / "mitmproxy-windows/mitmproxy_windows"
    validate_components(component)
    env["WINDIVERT_PATH"] = str(component)
    env["PATH"] = str(component) + os.pathsep + env["PATH"]
    profile = ["--release"] if args.release else []
    print("运行本地自动测试（不启动捕获、不加载驱动）…", flush=True)
    tests = run(["cargo", "test", "-p", "codey-traffic-service", "--features", "capture", "--locked", *profile], root, env)
    print(tests.stdout, flush=True)
    print("构建服务与验证程序…", flush=True)
    built = run(["cargo", "build", "-p", "codey-traffic-service", "--features", "capture", "--locked", "--bins", "--examples", "--message-format=json", *profile], root, env)
    test_build = run(["cargo", "test", "-p", "codey-traffic-service", "--features", "capture", "--locked", "--lib", "--no-run", "--message-format=json", *profile], root, env)
    executables = artifacts(built.stdout) | artifacts(test_build.stdout)
    if not {"codey-traffic-service", "traffic-probe", "unit-tests"} <= executables.keys():
        raise RuntimeError("验证程序构建产物不完整")
    desktop_results = []
    if args.desktop:
        print("构建桌面界面并验证启动接线（不启动真实 Codex）…", flush=True)
        run(["node", "scripts/build-overlay.mjs"], root, env)
        desktop_tests = run(["cargo", "test", "-p", "codey", "--lib", "--locked", "--no-run", "--message-format=json", *profile], root, env)
        desktop_artifacts = artifacts(desktop_tests.stdout)
        if "unit-tests" not in desktop_artifacts:
            raise RuntimeError("桌面测试程序构建产物缺失")
        executables["desktop-unit-tests"] = desktop_artifacts["unit-tests"]
        for test_filter in DESKTOP_TEST_FILTERS:
            result = run([str(executables["desktop-unit-tests"]), test_filter, "--test-threads=1"], root, env)
            desktop_results.append(result.stdout + result.stderr)
            print(result.stdout, flush=True)
        # Keep capture features out of the desktop executable; it talks to the
        # separately elevated helper through the private control pipe.
        desktop = run(["cargo", "build", "-p", "codey", "--bin", "codey", "--locked", "--message-format=json", *profile], root, env)
        desktop_artifacts = artifacts(desktop.stdout)
        if "codey" not in desktop_artifacts:
            raise RuntimeError("桌面程序构建产物缺失")
        executables["codey"] = desktop_artifacts["codey"]
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    destination = root / "output/traffic-service" / f"windows-x64-{stamp}-{uuid.uuid4().hex[:8]}"
    destination.mkdir(parents=True, exist_ok=False)
    for name in ("codey-traffic-service", "traffic-probe", "unit-tests"):
        shutil.copy2(executables[name], destination / f"{name}.exe")
    if args.desktop:
        for name in ("codey", "desktop-unit-tests"):
            shutil.copy2(executables[name], destination / f"{name}.exe")
    for name in ("WinDivert.dll", "WinDivert64.sys"):
        shutil.copy2(component / name, destination / name)
    shutil.copy2(root / "scripts/verify-traffic-service.ps1", destination / "verify.ps1")
    shutil.copy2(root / "crates/codey-traffic-service/README.md", destination / "README.md")
    licenses = destination / "licenses"
    licenses.mkdir()
    shutil.copy2(root / "LICENSE", licenses / "CodeyX-AGPL.txt")
    shutil.copy2(engine_root / "LICENSE", licenses / "mitmproxy-MIT.txt")
    shutil.copy2(component / "LICENSE", licenses / "WinDivert-LGPL.txt")
    # Overlay includes this task's uncommitted source, not only HEAD. It contains
    # an explicit allowlist; no application configuration, vault or user logs.
    source = destination / "source-overlay"
    paths = [root / name for name in SOURCE_FILES]
    paths += [path for path in (root / "crates/codey-traffic-service").rglob("*") if path.is_file() and path.suffix in {".rs", ".toml", ".md"}]
    for path in paths:
        target = source / path.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    (destination / "unit-test-results.txt").write_text(tests.stdout + tests.stderr, encoding="utf-8")
    if args.desktop:
        (destination / "desktop-test-results.txt").write_text("\n".join(desktop_results), encoding="utf-8")
    commit = run(["git", "rev-parse", "HEAD"], root, env).stdout.strip()
    manifest = {
        "schemaVersion": 1, "platform": "windows", "arch": "x86_64", "profile": "release" if args.release else "debug",
        "sourceCommit": commit, "sourceOverlayIncluded": True, "mitmproxyRevision": ENGINE_REVISION,
        "automaticTests": "passed", "driverLoadTest": "not-run", "nativeCaptureTest": "not-run",
        "nativeMultipleInstancesTest": "not-run",
        "desktopLaunchIntegration": "implemented-native-verification-pending",
        "desktopExecutableIncluded": args.desktop, "desktopAutomaticTests": "passed" if args.desktop else "not-run",
        "desktopTestFilters": list(DESKTOP_TEST_FILTERS) if args.desktop else [],
        "releaseReady": False,
        "files": {path.relative_to(destination).as_posix(): sha256(path) for path in sorted(destination.rglob("*")) if path.is_file()},
    }
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    archive = destination.with_suffix(".zip")
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as package:
        for path in sorted(destination.rglob("*")):
            if path.is_file():
                package.write(path, path.relative_to(destination).as_posix())
    print(archive)


if __name__ == "__main__":
    main()
