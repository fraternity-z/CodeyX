import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeBuildOutputs } from "./build-output.mjs";

// Keep these roots aligned with backend/build.rs and Tailwind's source scope.
const inputPaths = [
  "src", "public", "patches", ".gitignore",
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "scripts/build-overlay.mjs", "scripts/build-output.mjs", "scripts/overlay-build-cache.mjs",
  "node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml",
];
const rootConfig = /^(?:vite(?:\.[\w-]+)?\.config\.[cm]?[jt]s|(?:postcss|tailwind)\.config\.[cm]?[jt]s|tsconfig(?:\.[\w-]+)?\.json|\.env(?:\..+)?|\.browserslistrc)$/;
const buildEnvironment = /^(?:VITE_.+|NODE_ENV|NODE_OPTIONS|BROWSERSLIST(?:_.+)?|TAILWIND_MODE)$/;

function fingerprint(root, paths, context = "") {
  const hash = createHash("sha256").update(context);
  function visit(name) {
    const path = join(root, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    hash.update(JSON.stringify([name, stat?.isDirectory() ? "directory" : stat?.isFile() ? "file" : "missing"]));
    if (!stat) return true;
    // Build linked sources normally, but do not cache a tree we cannot fully
    // fingerprint. Linked outputs are rebuilt by writeBuildOutputs.
    if (stat.isSymbolicLink()) return false;
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) {
        if (!visit(`${name}/${child}`)) return false;
      }
    } else if (stat.isFile()) {
      hash.update(createHash("sha256").update(readFileSync(path)).digest());
    } else {
      throw new Error(`前端构建缓存不支持该文件类型：${name}`);
    }
    return true;
  }
  for (const path of [...paths].sort()) {
    if (!visit(path)) return null;
  }
  return hash.digest("hex");
}

function inputFingerprint(root, env) {
  const environment = Object.entries({ ...env, NODE_ENV: env.NODE_ENV || "production" })
    .filter(([name]) => buildEnvironment.test(name)).sort(([a], [b]) => a.localeCompare(b));
  const paths = [...inputPaths, ...readdirSync(root).filter(name => rootConfig.test(name))];
  return fingerprint(root, paths, JSON.stringify([process.version, process.platform, process.arch, environment]));
}

function readCache(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function requiredOutputs(root) {
  return [
    "codey-overlay.js", "codey.css", "codey-remote.js", "codey-remote.css",
    ...readdirSync(join(root, "public")).filter(name => name.endsWith(".js")).map(name => `inject/${name}`),
  ];
}

export async function buildOverlayWithCache({ root, build, force = false, env = process.env, log = console.log }) {
  // Vite mutates NODE_ENV while loading configuration; compare against the same
  // environment snapshot before and after the build.
  const environment = { ...env };
  const input = inputFingerprint(root, environment);
  const cachePath = join(root, ".vite", "overlay-build.json");
  const directory = join(root, "dist-overlay");
  const cached = readCache(cachePath);
  if (!force && input && cached?.version === 1 && cached.input === input && typeof cached.output === "string"
      && cached.output === fingerprint(root, ["dist-overlay"])) {
    log("[overlay] inputs and outputs unchanged; skipped frontend build");
    return false;
  }

  // A failed or interrupted rebuild must not leave a reusable success marker.
  rmSync(cachePath, { force: true });
  const outputs = await build(root);
  for (const name of requiredOutputs(root)) {
    if (!outputs.has(name) || Buffer.byteLength(outputs.get(name)) === 0) {
      throw new Error(`前端构建缺少产物：${name}`);
    }
  }
  if (input !== inputFingerprint(root, environment)) {
    throw new Error("前端输入在构建过程中发生变化，请重新运行 pnpm run vite:build");
  }
  writeBuildOutputs(directory, outputs);
  if (!input) return true;
  const output = fingerprint(root, ["dist-overlay"]);
  mkdirSync(dirname(cachePath), { recursive: true });
  // Store only digests, never source contents or environment values. A partial
  // JSON write is treated as a cache miss on the next invocation.
  writeFileSync(cachePath, `${JSON.stringify({ version: 1, input, output })}\n`);
  return true;
}
