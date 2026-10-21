import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadStartupSplash } from "../scripts/startup-splash.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "codey-startup-splash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, contents) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  write("backend/src/codex_startup_splash.html", '<style>.codey-splash{display:grid}</style><img src="__CODEY_STARTUP_ART__">');
  write("public/startup-art/gpt-claude.webp", "test-image-bytes");
  return { root, write };
}

test("startup markup embeds the exact local image without a runtime request", (t) => {
  const f = fixture(t);
  const markup = loadStartupSplash(f.root);
  assert.ok(markup.startsWith("<style>"));
  const source = /<img src="([^"]+)"/.exec(markup)?.[1];
  assert.ok(source?.startsWith("data:image/webp;base64,"));
  assert.equal(Buffer.from(source.split(",")[1], "base64").toString(), "test-image-bytes");
  assert.doesNotMatch(markup, /__CODEY_STARTUP_ART__|https?:|\/startup-art\//);
  f.write("backend/src/codex_startup_splash.html", "<style></style><div>Existing splash</div>");
  assert.equal(loadStartupSplash(f.root), "<style></style><div>Existing splash</div>");
});

test("missing startup source and art fail with the affected path", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "public/startup-art/gpt-claude.webp"));
  assert.throws(() => loadStartupSplash(f.root), /ENOENT[^\n]*gpt-claude\.webp/);
  rmSync(join(f.root, "backend/src/codex_startup_splash.html"));
  assert.throws(() => loadStartupSplash(f.root), /ENOENT[^\n]*codex_startup_splash\.html/);
});

test("the startup character asset stays within its static WebP budget", () => {
  const art = readFileSync(new URL("../public/startup-art/gpt-claude.webp", import.meta.url));
  assert.equal(art.toString("ascii", 0, 4), "RIFF");
  assert.equal(art.toString("ascii", 8, 12), "WEBP");
  assert.ok(art.length <= 350 * 1024, `Startup art exceeds 350 KiB: ${art.length} bytes`);
});
