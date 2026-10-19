import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binaries = ["codey", "codey-fastctx"];

export function verifyWslRuntime(directory) {
  for (const name of binaries) {
    const file = join(directory, name);
    const descriptor = openSync(file, "r");
    const header = Buffer.alloc(64);
    try {
      const length = readSync(descriptor, header, 0, header.length, 0);
      if (length !== header.length || header.toString("hex", 0, 4) !== "7f454c46"
        || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62
        || ![2, 3].includes(header.readUInt16LE(16))) {
        throw new Error(`WSL 组件必须是 Linux x64 ELF 可执行文件：${file}`);
      }
    } finally {
      closeSync(descriptor);
    }
  }
}

export function buildWslRuntime({
  root = projectRoot,
  output,
  debug = false,
  offline = false,
  distro,
  platform = process.platform,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  if (platform !== "win32" && platform !== "linux") {
    throw new Error("WSL 组件需在 Linux 或装有 Rust 工具链的 WSL 中构建");
  }
  const profile = debug ? "debug" : "release";
  const destination = resolve(root, output ?? join("target", profile, "wsl"));
  const target = join(root, "target", "wsl-runtime");
  const wslArgs = distro ? ["--distribution", distro] : [];
  let linuxRoot = root;
  if (platform === "win32") {
    const converted = spawn("wsl.exe", [...wslArgs, "--exec", "wslpath", "-u", root], {
      cwd: root, encoding: "utf8",
    });
    if (converted.error) throw converted.error;
    if (converted.status !== 0 || !converted.stdout?.trim().startsWith("/")) {
      throw new Error("无法访问 WSL 项目目录，请确认目标发行版可用，或通过 --distro 指定发行版");
    }
    linuxRoot = converted.stdout.trim();
  }
  const linuxTarget = posix.join(linuxRoot, "target", "wsl-runtime");
  const cargoArgs = [
    "build", "--locked", "-p", "codey", "-p", "codey-fastctx", "--bins",
    "--manifest-path", posix.join(linuxRoot, "Cargo.toml"),
    ...(debug ? [] : ["--release"]),
    ...(offline ? ["--offline"] : []),
  ];
  const buildEnvironment = {
    CODEY_SKIP_OVERLAY_BUILD: "1",
    CARGO_TARGET_DIR: linuxTarget,
    // WSL uses the native cache in .cargo/config.toml instead of linking through DrvFS.
    ...(platform === "linux" ? { CARGO_BUILD_BUILD_DIR: posix.join(linuxTarget, "build") } : {}),
  };
  const result = platform === "win32"
    ? spawn("wsl.exe", [...wslArgs, "--cd", linuxRoot, "--exec", "env",
      ...Object.entries(buildEnvironment).map(([key, value]) => `${key}=${value}`),
      "/bin/sh", "-c",
      'if [ -x "$HOME/.cargo/bin/cargo" ]; then exec "$HOME/.cargo/bin/cargo" "$@"; fi; exec cargo "$@"',
      "codey-wsl-build", ...cargoArgs], { cwd: root, stdio: "inherit" })
    : spawn("cargo", cargoArgs, {
      cwd: root, stdio: "inherit", env: { ...env, ...buildEnvironment },
    });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`WSL 组件构建失败（退出码 ${result.status ?? "unknown"}）；需要 Linux x64 Rust 工具链及已生成的前端资源`);
  }
  const source = join(target, profile);
  verifyWslRuntime(source);
  mkdirSync(destination, { recursive: true });
  for (const name of binaries) copyFileSync(join(source, name), join(destination, name));
  return destination;
}

function main() {
  const options = {};
  let verify = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--debug") options.debug = true;
    else if (argument === "--offline") options.offline = true;
    else if (argument === "--verify") verify = true;
    else if ((argument === "--output" || argument === "--distro") && args[index + 1]) {
      options[argument === "--output" ? "output" : "distro"] = args[++index];
    } else {
      throw new Error("用法：node scripts/build-wsl-runtime.mjs [--debug] [--offline] [--output <目录>] [--distro <WSL发行版>] [--verify]");
    }
  }
  if (verify) {
    verifyWslRuntime(resolve(projectRoot, options.output ?? join("target", options.debug ? "debug" : "release", "wsl")));
  } else {
    console.log(`Codey WSL runtime: ${buildWslRuntime(options)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
