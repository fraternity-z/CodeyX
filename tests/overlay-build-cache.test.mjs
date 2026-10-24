import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildOverlayWithCache } from "../scripts/overlay-build-cache.mjs";
import { runChecks } from "../scripts/release.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "codey-overlay-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, content = name) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  for (const name of [
    "src/overlay.tsx", "src/remote/main.tsx", "src/styles.css", "public/bridge.js",
    "vite.overlay.config.ts", "vite.remote.config.ts", "tsconfig.json", "package.json",
    "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches/example.patch",
    "scripts/build-overlay.mjs", "scripts/build-output.mjs", "scripts/overlay-build-cache.mjs",
    "scripts/startup-splash.mjs", "backend/src/codex_startup_splash.html", "public/startup-art/gpt-claude.webp",
    "backend/icons/Codey.png",
    "node_modules/.pnpm/lock.yaml", "node_modules/.modules.yaml", ".gitignore",
  ]) write(name);
  const outputs = new Map([
    ["codey-overlay.js", "overlay"], ["codey.css", "styles"],
    ["codey-remote.js", "remote"], ["codey-remote.css", "remote styles"],
    ["inject/bridge.js", "bridge"],
    ["inject/startup-splash.html", "startup splash"],
  ]);
  let calls = 0;
  const build = async directory => {
    assert.equal(directory, root);
    calls += 1;
    return new Map(outputs);
  };
  const messages = [];
  return {
    root, write, outputs, messages,
    cache: join(root, ".vite/overlay-build.json"),
    calls: () => calls,
    run: (options = {}) => buildOverlayWithCache({ root, build, env: {}, log: message => messages.push(message), ...options }),
  };
}

test("unchanged frontend skips the compiler and preserves output and cache mtimes", async t => {
  const f = fixture(t);
  assert.equal(await f.run(), true);
  const output = join(f.root, "dist-overlay/codey-overlay.js");
  for (const path of [output, f.cache, join(f.root, "src/overlay.tsx")]) utimesSync(path, 1, 1);
  f.write("backend/src/main.rs", "changed backend");
  f.write("README.md", "changed documentation");
  assert.equal(await f.run(), false);
  assert.equal(f.calls(), 1);
  assert.equal(statSync(output).mtimeMs, 1000);
  assert.equal(statSync(f.cache).mtimeMs, 1000);
  assert.match(f.messages[0], /skipped frontend build/);
});

for (const name of [
  "src/overlay.tsx", "src/remote/main.tsx", "src/styles.css", "public/bridge.js",
  "vite.overlay.config.ts", "vite.remote.config.ts", "tsconfig.json", "package.json",
  "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches/example.patch",
  "scripts/build-overlay.mjs", "scripts/build-output.mjs", "scripts/overlay-build-cache.mjs",
  "scripts/startup-splash.mjs", "backend/src/codex_startup_splash.html", "public/startup-art/gpt-claude.webp",
  "backend/icons/Codey.png",
  "node_modules/.pnpm/lock.yaml", "node_modules/.modules.yaml", ".gitignore", ".env.production.local",
  "tsconfig.build.json", "postcss.config.cjs",
]) {
  test(`changing a frontend input rebuilds even with an old mtime: ${name}`, async t => {
    const f = fixture(t);
    await f.run();
    const path = f.write(name, "changed");
    utimesSync(path, 1, 1);
    assert.equal(await f.run(), true);
    assert.equal(await f.run(), false);
    assert.equal(f.calls(), 2);
  });
}

test("new, renamed and deleted source files invalidate the fingerprint", async t => {
  const f = fixture(t);
  await f.run();
  const added = f.write("src/new.ts", "new source");
  assert.equal(await f.run(), true);
  const renamed = join(f.root, "src/renamed.ts");
  renameSync(added, renamed);
  assert.equal(await f.run(), true);
  rmSync(renamed);
  assert.equal(await f.run(), true);
  assert.equal(f.calls(), 4);
});

test("public injection additions and removals rebuild and prune obsolete outputs", async t => {
  const f = fixture(t);
  await f.run();
  const added = f.write("public/new.js", "new injection");
  f.outputs.set("inject/new.js", "new injection");
  await f.run();
  assert.ok(existsSync(join(f.root, "dist-overlay/inject/new.js")));
  rmSync(added);
  f.outputs.delete("inject/new.js");
  await f.run();
  assert.equal(existsSync(join(f.root, "dist-overlay/inject/new.js")), false);
});

for (const name of ["codey-overlay.js", "codey.css", "codey-remote.js", "codey-remote.css", "inject/bridge.js", "inject/startup-splash.html"]) {
  test(`missing and corrupt output causes a rebuild: ${name}`, async t => {
    const f = fixture(t);
    await f.run();
    const path = join(f.root, "dist-overlay", name);
    rmSync(path);
    assert.equal(await f.run(), true);
    f.write(`dist-overlay/${name}`, "corrupted");
    assert.equal(await f.run(), true);
    assert.equal(readFileSync(path, "utf8"), f.outputs.get(name));
    assert.equal(f.calls(), 3);
  });
}

test("obsolete output and a removed output directory cannot reuse the cache", async t => {
  const f = fixture(t);
  await f.run();
  const obsolete = f.write("dist-overlay/stale/file.js", "old bundle");
  assert.equal(await f.run(), true);
  assert.equal(existsSync(obsolete), false);
  rmSync(join(f.root, "dist-overlay"), { recursive: true });
  assert.equal(await f.run(), true);
});

test("missing, invalid and incompatible cache records rebuild", async t => {
  const f = fixture(t);
  await f.run();
  for (const data of ["{", "null", "{}", '{"version":0}', '{"version":1,"input":"wrong"}']) {
    writeFileSync(f.cache, data);
    assert.equal(await f.run(), true);
  }
  rmSync(f.cache);
  assert.equal(await f.run(), true);
});

test("unexpected cache read errors are reported instead of silently overwriting state", async t => {
  const f = fixture(t);
  mkdirSync(f.cache, { recursive: true });
  await assert.rejects(f.run(), { code: "EISDIR" });
  assert.equal(f.calls(), 0);
});

test("build environment changes invalidate the cache without storing its values", async t => {
  const f = fixture(t);
  await f.run();
  assert.equal(await f.run({ env: { NODE_ENV: "production", CODEY_SKIP_OVERLAY_BUILD: "1" } }), false);
  for (const name of ["VITE_API_URL", "NODE_ENV", "NODE_OPTIONS", "BROWSERSLIST_ENV", "TAILWIND_MODE"]) {
    assert.equal(await f.run({ env: { [name]: "private-test-value" } }), true);
    assert.ok(!readFileSync(f.cache, "utf8").includes("private-test-value"));
  }
});

test("force rebuilds preserve identical outputs and a failed rebuild removes the success marker", async t => {
  const f = fixture(t);
  await f.run();
  const output = join(f.root, "dist-overlay/codey-overlay.js");
  utimesSync(output, 1, 1);
  assert.equal(await f.run({ force: true }), true);
  assert.equal(statSync(output).mtimeMs, 1000);
  await assert.rejects(f.run({ force: true, build: async () => { throw new Error("compiler failed"); } }), /compiler failed/);
  assert.equal(existsSync(f.cache), false);
  assert.equal(await f.run(), true);
});

test("partial or empty builds and changes during compilation never produce a cache hit", async t => {
  const f = fixture(t);
  for (const value of [undefined, ""]) {
    await assert.rejects(f.run({ build: async () => {
      const outputs = new Map(f.outputs);
      if (value === undefined) outputs.delete("inject/bridge.js");
      else outputs.set("inject/bridge.js", value);
      return outputs;
    } }), /前端构建缺少产物：inject\/bridge.js/);
    assert.equal(existsSync(f.cache), false);
  }
  await assert.rejects(f.run({ build: async () => {
    f.write("src/overlay.tsx", "changed while compiling");
    return f.outputs;
  } }), /前端输入在构建过程中发生变化/);
  assert.equal(existsSync(f.cache), false);
  assert.equal(await f.run(), true);
});

test("linked source directories build without caching and linked outputs are replaced safely", async t => {
  const f = fixture(t);
  const outside = join(f.root, "external");
  f.write("external/untouched.js", "untouched");
  const source = join(f.root, "src/linked");
  symlinkSync(outside, source, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await f.run(), true);
  assert.equal(await f.run(), true);
  assert.equal(existsSync(f.cache), false);
  rmSync(source);
  await f.run();
  const injection = join(f.root, "dist-overlay/inject");
  rmSync(injection, { recursive: true });
  symlinkSync(outside, injection, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await f.run(), true);
  assert.equal(readFileSync(join(outside, "untouched.js"), "utf8"), "untouched");
  assert.equal(await f.run(), false);
});

test("release checks build the frontend once and pass readiness only to subsequent Rust checks", () => {
  const calls = [];
  const env = { NO_PROXY: "127.0.0.1", CODEY_SKIP_OVERLAY_BUILD: "0" };
  runChecks((...args) => calls.push(args), env);
  assert.equal(calls.filter(([, args]) => args.includes("vite:build")).length, 1);
  const frontend = calls.findIndex(([, args]) => args.includes("vite:build"));
  const rust = calls.filter(([command, args]) => command === "cargo" && ["test", "clippy"].includes(args[0]));
  assert.equal(rust.length, 2);
  for (const call of rust) {
    assert.ok(calls.indexOf(call) > frontend);
    assert.deepEqual(call[2].env, { NO_PROXY: "127.0.0.1", CODEY_SKIP_OVERLAY_BUILD: "1" });
  }
  assert.equal(env.CODEY_SKIP_OVERLAY_BUILD, "0");
  const failedCalls = [];
  assert.throws(() => runChecks((command, args) => {
    failedCalls.push(command);
    if (args.includes("vite:build")) throw new Error("frontend failed");
  }), /frontend failed/);
  assert.ok(!failedCalls.includes("cargo"));
});
