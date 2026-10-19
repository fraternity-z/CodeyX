import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  cargoProfile,
  codeyExecutablePaths,
  configuredWslDevelopment,
  ensureUnlockedCodeyOnWindows,
  forceKillEnabled,
  wslDevelopmentOptions,
  wslDistroAvailable,
  wslRuntimePreparation,
} from "../scripts/dev.mjs";

test("WSL development builds Linux components next to the exact Windows executable", () => {
  const root = resolve("/workspace/codey").toLowerCase();
  const prepared = wslDevelopmentOptions({
    args: ["--wsl", "--release", "--", "--debug-port", "9999"],
    root,
    platform: "win32",
    env: { CARGO_TARGET_DIR: "target/isolated", CODEY_WSL_DISTRO: "Other Ubuntu", CARGO_NET_OFFLINE: "true" },
  });
  assert.deepEqual(prepared.args, ["--release", "--", "--debug-port", "9999"]);
  assert.deepEqual(prepared.build, {
    root,
    output: join(root, "target", "isolated", "release", "wsl"),
    debug: false,
    distro: "Other Ubuntu",
    offline: true,
  });
  const debug = wslDevelopmentOptions({ args: ["--wsl"], root, platform: "win32", env: {} });
  assert.equal(debug.build.debug, true);
  assert.equal(debug.build.output, join(root, "target", "debug", "wsl"));
});

test("WSL development leaves normal and application arguments unchanged", () => {
  for (const args of [[], ["--release"], ["--", "--wsl"]]) {
    assert.deepEqual(wslDevelopmentOptions({ args, platform: "darwin" }), { args });
  }
  assert.throws(
    () => wslDevelopmentOptions({ args: ["--wsl"], platform: "darwin" }),
    /仅适用于 Windows/,
  );
});

test("normal Windows development prepares WSL when Codex has selected the Linux backend", () => {
  const root = resolve("/workspace/codey").toLowerCase();
  const args = ["--profile", "custom", "--", "--debug-port", "9999"];
  const env = { CARGO_TARGET_DIR: "target/isolated" };
  let query;
  const enabled = configuredWslDevelopment({
    args, root, env, platform: "win32",
    spawn(command, arguments_, options) {
      query = { command, args: arguments_, options };
      return { status: 0, stdout: "true\r\n" };
    },
  });
  assert.equal(enabled, true);
  assert.deepEqual(query.args, [
    "run", "-p", "codey", "--manifest-path", join(root, "Cargo.toml"),
    "--profile", "custom", "--", "--codey-wsl-status",
  ]);
  assert.equal(query.command, "cargo");
  assert.equal(query.options.env, env);
  assert.equal(query.options.cwd, root);
  const prepared = wslDevelopmentOptions({ args, root, env, platform: "win32", enabled });
  assert.deepEqual(prepared.args, args);
  assert.equal(prepared.build.output, join(root, "target", "isolated", "custom", "wsl"));
});

test("WSL development probing does not require WSL for native Windows or other platforms", () => {
  assert.equal(configuredWslDevelopment({
    args: [], platform: "linux", spawn() { assert.fail("must not spawn"); },
  }), false);
  assert.equal(configuredWslDevelopment({
    args: [], platform: "win32", spawn: () => ({ status: 0, stdout: "false\n" }),
  }), false);
});

test("Windows development prepares WSL whenever a distro can run, so Codex can switch backends", () => {
  const unavailable = () => assert.fail("selected backends must not probe optional WSL");
  assert.equal(wslRuntimePreparation({ explicit: true, enabled: false, available: unavailable }), "required");
  assert.equal(wslRuntimePreparation({ explicit: false, enabled: true, available: unavailable }), "required");
  assert.equal(wslRuntimePreparation({ explicit: false, enabled: false, available: () => true }), "optional");
  assert.equal(wslRuntimePreparation({ explicit: false, enabled: false, available: () => false }), "skip");

  let probe;
  assert.equal(wslDistroAvailable({
    distro: "Other Ubuntu",
    platform: "win32",
    spawn(command, args, options) {
      probe = { command, args, options };
      return { status: 0 };
    },
  }), true);
  assert.equal(probe.command, "wsl.exe");
  assert.deepEqual(probe.args, ["--distribution", "Other Ubuntu", "--exec", "/bin/true"]);
  assert.equal(probe.options.windowsHide, true);
  assert.ok(probe.options.timeout > 0);
  for (const result of [{ status: 1 }, { status: null }, { error: new Error("wsl.exe missing") }]) {
    assert.equal(wslDistroAvailable({ platform: "win32", spawn: () => result }), false);
  }
  assert.equal(wslDistroAvailable({
    platform: "linux", spawn: () => assert.fail("must not spawn"),
  }), false);
});

test("WSL development honors Cargo offline mode without treating application flags as Cargo options", () => {
  for (const [args, expected] of [[["--offline"], true], [["--", "--offline"], false]]) {
    const prepared = wslDevelopmentOptions({
      args, enabled: true, platform: "win32", env: {},
    });
    assert.equal(prepared.build.offline, expected);
  }
});

test("invalid WSL settings probes stop before desktop startup instead of assuming native mode", () => {
  for (const result of [
    { status: 1, stdout: "false" },
    { status: 0, stdout: "" },
    { status: 0, stdout: "unexpected output" },
  ]) {
    assert.throws(() => configuredWslDevelopment({
      args: [], platform: "win32", spawn: () => result,
    }), /无法读取 Codex WSL 设置/);
  }
  const error = new Error("cargo missing");
  assert.throws(() => configuredWslDevelopment({
    args: [], platform: "win32", spawn: () => ({ error }),
  }), error);
});

test("dev script derives the exact Cargo output executable", () => {
  const root = "/workspace/codey";
  const env = {};

  assert.equal(cargoProfile([]), "debug");
  assert.equal(cargoProfile(["--release"]), "release");
  assert.equal(cargoProfile(["--", "--release"]), "debug");
  assert.equal(cargoProfile(["--profile", "bench"]), "bench");
  assert.equal(cargoProfile(["--profile=custom"]), "custom");
  assert.deepEqual(codeyExecutablePaths({ root, args: [], env }), [
    join(root, "target", "debug", "codey.exe").toLowerCase(),
  ]);
  assert.deepEqual(
    codeyExecutablePaths({ root, args: ["--release"], env }),
    [join(root, "target", "release", "codey.exe").toLowerCase()],
  );
  assert.deepEqual(
    codeyExecutablePaths({ root, args: ["--target", "x86_64-pc-windows-msvc"], env }),
    [join(root, "target", "x86_64-pc-windows-msvc", "debug", "codey.exe").toLowerCase()],
  );
  assert.deepEqual(codeyExecutablePaths({ root, args: ["--profile", "../other"], env }), []);
});

test("force termination requires an explicit opt-in", () => {
  assert.equal(forceKillEnabled({}), false);
  assert.equal(forceKillEnabled({ CODEY_DEV_FORCE_KILL: "true" }), false);
  assert.equal(forceKillEnabled({ CODEY_DEV_FORCE_KILL: "1" }), true);
});

test("Windows dev start stops before Cargo unless force termination is requested", () => {
  const messages = [];
  const log = {
    error: (message) => messages.push(message),
    log: () => assert.fail("should not report a forced termination"),
    warn: () => assert.fail("should inspect the matching process successfully"),
  };
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    return { status: 0, stdout: "412\r\n" };
  };

  const proceed = ensureUnlockedCodeyOnWindows({
    args: [],
    env: {},
    log,
    platform: "win32",
    root: "/workspace/codey",
    spawn,
  });

  assert.equal(proceed, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1][3], /^\$paths = @\(.+\); Get-CimInstance/);
  assert.match(messages[0], /CODEY_DEV_FORCE_KILL=1/);
});

test("Windows dev start verifies a forced termination before continuing", () => {
  const messages = [];
  const responses = [
    { status: 0, stdout: "412\n" },
    { status: 0, stdout: "412\n" },
    { status: 0, stdout: "" },
  ];
  const calls = [];
  const proceed = ensureUnlockedCodeyOnWindows({
    args: [],
    env: { CODEY_DEV_FORCE_KILL: "1" },
    log: {
      error: (message) => messages.push(message),
      log: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    },
    platform: "win32",
    root: "/workspace/codey",
    spawn: (...args) => {
      calls.push(args);
      return responses.shift();
    },
  });

  assert.equal(proceed, true);
  assert.equal(responses.length, 0);
  assert.match(calls[1][1][3], /Where-Object .+ \| ForEach-Object/s);
  assert.deepEqual(messages, ["[dev] 已强制结束本地 Codey 进程：412"]);
});

test("Windows dev start does not continue when a forced termination fails", () => {
  const messages = [];
  const responses = [
    { status: 0, stdout: "412\n" },
    { status: 1, stderr: "access denied" },
  ];
  const proceed = ensureUnlockedCodeyOnWindows({
    args: [],
    env: { CODEY_DEV_FORCE_KILL: "1" },
    log: {
      error: (message) => messages.push(message),
      log: () => assert.fail("should not report a forced termination"),
      warn: () => assert.fail("should not downgrade a termination failure"),
    },
    platform: "win32",
    root: "/workspace/codey",
    spawn: () => responses.shift(),
  });

  assert.equal(proceed, false);
  assert.equal(responses.length, 0);
  assert.match(messages[0], /access denied/);
});
