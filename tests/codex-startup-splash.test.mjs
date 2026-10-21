import assert from "node:assert/strict";
import test from "node:test";

import { loadStartupPatchTemplate } from "./helpers/startup-patch.mjs";
import { loadStartupSplashMarkup } from "./helpers/startup-splash.mjs";

const bootstrapHtml = [
  "<!doctype html><html><head><style>.startup-loader{display:flex}</style></head>",
  '<body tabindex="0" style="outline: none">',
  '<div id="root"><div class="startup-loader" aria-hidden="true"></div></div>',
  "</body></html>",
].join("");

async function installAppProtocolHandler(startupSplash) {
  const Module = process.getBuiltinModule("module");
  const nativeLoad = Module._load;
  let installedHandler = null;
  const fakeElectron = {
    app: { getVersion: () => "26.1007.2314" },
    protocol: {
      handle(scheme, handler) {
        assert.equal(scheme, "app");
        installedHandler = handler;
      },
    },
  };
  Module._load = function testElectronLoader(request) {
    if (request === "electron") return fakeElectron;
    return Reflect.apply(nativeLoad, this, arguments);
  };
  try {
    assert.equal(
      (0, eval)(await loadStartupPatchTemplate({ startupSplash })),
      "codey-startup-patch-installed-v40",
    );
    const electron = Module._load("electron", undefined, false);
    return (upstream) => {
      electron.protocol.handle("app", upstream);
      return installedHandler;
    };
  } finally {
    Module._load = nativeLoad;
  }
}

test("the CodeyX splash is embedded only into the primary Codex bootstrap page", async () => {
  const splash = loadStartupSplashMarkup();
  const useUpstream = await installAppProtocolHandler(splash);
  const handler = useUpstream(async () =>
    new Response(bootstrapHtml, {
      headers: { "content-type": "text/html", "content-length": "1", etag: "upstream" },
    }));

  const primary = await handler({ url: "app://-/index.html" });
  const primaryHtml = await primary.text();
  assert.equal(primary.headers.get("content-type"), "text/html");
  assert.equal(primary.headers.get("content-length"), null);
  assert.equal(primary.headers.get("etag"), null);
  const splashAt = primaryHtml.indexOf('<div class="codey-splash"');
  assert.ok(splashAt > primaryHtml.indexOf("<body"));
  assert.ok(splashAt < primaryHtml.indexOf('<div id="root">'));
  assert.equal(primaryHtml.match(/class="codey-splash"/g).length, 1);

  for (const url of [
    "app://-/index.html?initialRoute=%2Favatar-overlay",
    "app://-/index.html?initialRoute=%2Fhotkey-window",
  ]) {
    const secondary = await handler({ url });
    assert.equal(await secondary.text(), bootstrapHtml, url);
  }

  const unknownShell = useUpstream(async () =>
    new Response("<!doctype html><body><div id=\"root\"></div></body>"));
  assert.doesNotMatch(
    await (await unknownShell({ url: "app://-/index.html" })).text(),
    /codey-splash/,
  );
});

test("the splash waits for a usable Codex screen and keeps a CSP-safe CSS fallback", async () => {
  const splash = loadStartupSplashMarkup();
  assert.doesNotMatch(splash, /<script\b/i, "Codex CSP rejects inline scripts");
  assert.doesNotMatch(splash, /body:not\(:has\(> #root > \.startup-loader\)\)/);
  assert.match(splash, /\[data-app-navigation-rail\]/);
  assert.match(splash, /\.codey-splash\[data-codey-splash-ready\] \{[^}]*animation: codey-splash-exit/);
  assert.match(splash, /@keyframes codey-splash-exit \{ to \{[^}]*visibility: hidden/);
  assert.match(splash, /@media \(prefers-reduced-motion: reduce\)/);
});
