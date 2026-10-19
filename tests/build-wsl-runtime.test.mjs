import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildWslRuntime, verifyWslRuntime } from "../scripts/build-wsl-runtime.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "codey-wsl-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function binaries(directory, machine = 62) {
  mkdirSync(directory, { recursive: true });
  const header = Buffer.alloc(64);
  header.write("\x7fELF", 0, "binary");
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(machine, 18);
  for (const name of ["codey", "codey-fastctx"]) writeFileSync(join(directory, name), header);
}

test("Linux build isolates Cargo outputs and stages both verified runtime binaries", (t) => {
  const root = fixture(t);
  const calls = [];
  const output = buildWslRuntime({ root, platform: "linux", env: { SENTINEL: "preserved" }, spawn(command, args, options) {
    calls.push({ command, args, options });
    binaries(join(root, "target", "wsl-runtime", "release"));
    return { status: 0 };
  } });
  assert.equal(output, join(root, "target", "release", "wsl"));
  verifyWslRuntime(output);
  assert.equal(calls[0].command, "cargo");
  assert.ok(calls[0].args.includes("--locked"));
  assert.ok(calls[0].args.includes("--release"));
  assert.ok(calls[0].args.includes("codey-fastctx"));
  assert.equal(calls[0].options.env.SENTINEL, "preserved");
  assert.equal(calls[0].options.env.CODEY_SKIP_OVERLAY_BUILD, "1");
  assert.match(calls[0].options.env.CARGO_TARGET_DIR, /target\/wsl-runtime$/);
  assert.match(calls[0].options.env.CARGO_BUILD_BUILD_DIR, /target\/wsl-runtime\/build$/);
});

test("Windows delegates directly to the selected WSL distro with translated paths", (t) => {
  const root = fixture(t);
  const calls = [];
  const output = buildWslRuntime({ root, platform: "win32", distro: "Ubuntu", debug: true, output: "output/runtime with spaces", spawn(command, args, options) {
    calls.push({ command, args, options });
    if (args.includes("wslpath")) return { status: 0, stdout: "/mnt/e/Codey Project\n" };
    binaries(join(root, "target", "wsl-runtime", "debug"));
    return { status: 0 };
  } });
  verifyWslRuntime(output);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["--distribution", "Ubuntu", "--exec", "wslpath", "-u", root]);
  assert.deepEqual(calls[1].args.slice(0, 6), ["--distribution", "Ubuntu", "--cd", "/mnt/e/Codey Project", "--exec", "env"]);
  assert.ok(calls[1].args.includes("CARGO_TARGET_DIR=/mnt/e/Codey Project/target/wsl-runtime"));
  assert.ok(!calls[1].args.some(arg => arg.startsWith("CARGO_BUILD_BUILD_DIR=")));
  assert.ok(calls[1].args.includes("/mnt/e/Codey Project/Cargo.toml"));
  assert.ok(!calls[1].args.includes("--release"));
  assert.ok(calls[1].args.includes("/bin/sh"));
  assert.ok(calls[1].args.includes('if [ -x "$HOME/.cargo/bin/cargo" ]; then exec "$HOME/.cargo/bin/cargo" "$@"; fi; exec cargo "$@"'));
  assert.ok(calls[1].args.includes("codey-wsl-build"));
  assert.equal(calls[1].options.shell, undefined);
});

test("offline WSL builds explicitly disable Cargo network access inside Linux", (t) => {
  const root = fixture(t);
  const calls = [];
  buildWslRuntime({ root, platform: "win32", offline: true, spawn(command, args) {
    calls.push({ command, args });
    if (args.includes("wslpath")) return { status: 0, stdout: "/mnt/e/codey\n" };
    binaries(join(root, "target", "wsl-runtime", "release"));
    return { status: 0 };
  } });
  assert.ok(calls[1].args.includes("--offline"));
});

test("failed WSL conversion or compilation never stages stale artifacts", (t) => {
  const root = fixture(t);
  binaries(join(root, "target", "wsl-runtime", "release"));
  assert.throws(() => buildWslRuntime({ root, platform: "win32", spawn: () => ({ status: 1 }) }), /无法访问 WSL/);
  assert.throws(() => buildWslRuntime({ root, platform: "linux", spawn: () => ({ status: 1 }) }), /构建失败/);
  assert.ok(!existsSync(join(root, "target", "release", "wsl")));
});

test("unsupported hosts, process errors and invalid output fail before staging", (t) => {
  const root = fixture(t);
  const launchError = new Error("cargo is unavailable");
  assert.throws(() => buildWslRuntime({ root, platform: "darwin" }), /Linux/);
  assert.throws(() => buildWslRuntime({ root, platform: "win32", spawn: () => ({ error: launchError }) }), launchError);
  assert.throws(() => buildWslRuntime({ root, platform: "linux", spawn: () => ({ error: launchError }) }), launchError);
  assert.throws(() => buildWslRuntime({ root, platform: "linux", spawn() {
    const source = join(root, "target", "wsl-runtime", "release");
    binaries(source);
    writeFileSync(join(source, "codey-fastctx"), "invalid");
    return { status: 0 };
  } }), /Linux x64 ELF/);
  assert.ok(!existsSync(join(root, "target", "release", "wsl")));
});

test("runtime validation rejects Windows, wrong architecture and missing sidecars", (t) => {
  const root = fixture(t);
  binaries(root, 183);
  assert.throws(() => verifyWslRuntime(root), /Linux x64 ELF/);
  binaries(root);
  writeFileSync(join(root, "codey-fastctx"), "MZ Windows executable");
  assert.throws(() => verifyWslRuntime(root), /Linux x64 ELF/);
  rmSync(join(root, "codey-fastctx"));
  assert.throws(() => verifyWslRuntime(root), { code: "ENOENT" });
});

test("Windows installer includes and removes only the packaged WSL runtime files", () => {
  const installer = readFileSync(new URL("../scripts/installer/windows/Codey.nsi", import.meta.url), "utf8");
  for (const name of ["codey", "codey-fastctx"]) {
    assert.ok(installer.includes(`File "${"${PROJECT_ROOT}"}\\target\\release\\wsl\\${name}"`));
    assert.ok(installer.includes(`Delete "$INSTDIR\\wsl\\${name}"`));
  }
  assert.ok(installer.includes('RMDir "$INSTDIR\\wsl"'));
  assert.ok(!installer.includes('RMDir /r "$INSTDIR\\wsl"'));
});

test("Windows release packaging requires Linux runtime from the same workflow source", () => {
  const workflow = readFileSync(new URL("../.github/workflows/build-desktop.yml", import.meta.url), "utf8");
  const runtime = workflow.slice(workflow.indexOf("\n  wsl-runtime:"), workflow.indexOf("\n  notes:"));
  const windows = workflow.slice(workflow.indexOf("\n  windows:"), workflow.indexOf("\n  windows-check:"));
  assert.match(runtime, /runs-on: ubuntu-22\.04/);
  assert.match(runtime, /ref: \$\{\{ inputs\.source_sha \|\| github\.ref \}\}/);
  assert.match(runtime, /Inject validated platform release version/);
  assert.match(runtime, /node scripts\/build-wsl-runtime\.mjs/);
  assert.match(runtime, /name: wsl-runtime-x64/);
  assert.match(windows, /needs: \[prepare, wsl-runtime\]/);
  assert.match(windows, /name: wsl-runtime-x64\s+path: target\/release\/wsl/);
  assert.ok(windows.indexOf("node scripts/build-wsl-runtime.mjs --verify") < windows.indexOf("- name: Build Windows packages"));
});
