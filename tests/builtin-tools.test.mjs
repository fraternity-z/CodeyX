import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const { indexSummary, indexNeedsRepair } = await loadTypeScriptModule(new URL("../src/builtinTools.ts", import.meta.url));
const { createBuiltinToolsPreview } = await loadTypeScriptModule(new URL("../src/dev/builtinToolsMock.ts", import.meta.url));

test("index status distinguishes missing, interrupted, stale and ready indexes", () => {
  assert.equal(indexSummary({ initialized: false }), "尚未建立索引");
  for (const state of ["partial", "failed", "indexing"]) {
    assert.equal(indexNeedsRepair({ initialized: true, index: { state } }), true);
    assert.equal(indexSummary({ initialized: true, index: { state } }), "索引需要重建");
  }
  assert.equal(indexNeedsRepair({ index: { reindexRecommended: true } }), true);
  assert.equal(indexSummary({ initialized: true, pendingChanges: { added: 1, modified: 0, removed: 0 } }), "有变更待同步");
  assert.equal(indexSummary({ initialized: true, index: { pendingRefs: 2 } }), "有变更待同步");
  assert.equal(indexSummary({ initialized: true, index: { filesWithParseErrors: 1 } }), "部分文件解析失败");
  assert.equal(indexSummary({ initialized: true }), "索引已就绪");
});

test("enabling needs no project path and waits for project chat after installation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const request = createBuiltinToolsPreview();
  assert.equal((await request({ action: "status" })).installed, false);
  const started = await request({ action: "set_enabled", enabled: true });
  assert.equal(started.job.phase, "running");
  await assert.rejects(request({ action: "set_enabled", enabled: true }), /进行中/);
  t.mock.timers.tick(3000);
  const finished = await request({ action: "status" });
  assert.equal(finished.job.phase, "succeeded");
  assert.equal(finished.mcp.enabled, true);
  assert.equal(finished.mcp.automatic, true);
  assert.deepEqual(finished.projects, []);
  await request({ action: "set_enabled", enabled: false });
  assert.equal((await request({ action: "status" })).mcp.enabled, false);
  assert.equal((await request({ action: "status" })).job, null);
  await assert.rejects(request({ action: "pick_project" }), /未知/);
});

test("FastCtx belongs to the built-in tools page instead of basic feature policies", async () => {
  const [layout, basics, app] = await Promise.all(["SettingsLayout.tsx", "FeaturePolicyCard.tsx", "App.tsx"].map(file => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")));
  assert.match(layout, /id: "tools", title: "内置工具"/);
  assert.doesNotMatch(basics, /FastCtx|fastContextTools/);
  assert.match(app, /tools: \(active\) => \([\s\S]*?<BuiltinToolsPage active=\{active\}/);
});
