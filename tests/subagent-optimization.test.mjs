import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("subagent settings expose the five supported role controls", async () => {
  const [featurePolicySource, modelHookSource, modelOptionsSource, comboboxSource] = await Promise.all([
    readFile(new URL("src/features/subagents/SubagentPolicyCard.tsx", root), "utf8"),
    readFile(new URL("src/features/model-selection/useModelSelectionController.ts", root), "utf8"),
    readFile(new URL("src/subagentModels.ts", root), "utf8"),
    readFile(new URL("src/components/ModelCombobox.tsx", root), "utf8"),
  ]);

  assert.match(featurePolicySource, /checked=\{config\.subagentOptimization\}/);
  assert.match(
    featurePolicySource,
    /onCheckedChange=\{onSubagentOptimizationChange\}/,
  );
  const roleSource = await readFile(new URL("src/features/subagents/state.ts", root), "utf8");
  for (const [id, name] of [
    ["codey_quick_scan", "快速定位"],
    ["codey_deep_research", "深度检索"],
    ["codey_visual_analysis", "视觉分析"],
    ["codey_worker", "代码实施"],
    ["codey_visual_worker", "视觉实施"],
  ]) {
    assert.match(roleSource, new RegExp(`id: "${id}"`));
    assert.match(roleSource, new RegExp(`name: "${name}"`));
  }
  assert.match(featurePolicySource, /config\.subagentRoles\[id\]/);
  assert.match(featurePolicySource, /checked=\{selection\.enabled\}/);
  assert.match(featurePolicySource, /controller\.updateRole\(id, \{ enabled \}\)/);
  assert.match(featurePolicySource, /只读/);
  assert.doesNotMatch(featurePolicySource, /默认子代理|各角色工具权限一致/);
  assert.match(roleSource, /kind: "analysis"/);
  assert.match(roleSource, /kind: "implementation"/);
  assert.match(featurePolicySource, /<ModelCombobox/);
  assert.match(
    modelHookSource,
    /buildSubagentModelOptions\(\s*config,\s*modelState,\s*officialAccountAvailable/,
  );
  assert.match(modelHookSource, /officialAccountAvailable,\s*currentProvider/);
  assert.match(modelOptionsSource, /for \(const profile of config\.profiles\)/);
  assert.match(modelOptionsSource, /value: routeModelAlias\(profile, modelId\)/);
  assert.match(modelOptionsSource, /if \(!config\.localRouterEnabled\)/);
  assert.match(modelOptionsSource, /currentProvider\?\.id/);
  assert.match(modelOptionsSource, /value: modelId/);
  assert.match(modelOptionsSource, /: modelState\.thirdPartyModels/);
  assert.match(modelOptionsSource, /official && officialModelMetadata/);
  assert.match(
    modelOptionsSource,
    /THIRD_PARTY_REASONING_EFFORTS\s*=\s*\["low",\s*"medium",\s*"high",\s*"xhigh"\]/,
  );
  assert.match(
    modelOptionsSource,
    /THIRD_PARTY_REASONING_EFFORT_ALLOWLIST\s*=\s*\[\s*"low",\s*"medium",\s*"high",\s*"xhigh",\s*"max",\s*"ultra"/,
  );
  assert.match(modelOptionsSource, /modelState\.thirdPartyModelMetadata/);
  assert.match(modelOptionsSource, /resolveSubagentModelOption/);
  assert.match(comboboxSource, /<ComboBox/);
  assert.match(comboboxSource, /<ListBox\.Section/);
  assert.match(comboboxSource, /没有匹配的模型或线路/);
  assert.match(comboboxSource, /items=\{groups\}/);
});
