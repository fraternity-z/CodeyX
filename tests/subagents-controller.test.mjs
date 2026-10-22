import assert from "node:assert/strict";
import test from "node:test";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";
import { createControllerHarness } from "./helpers/controller-harness.mjs";

const feature = new URL("../src/features/subagents/", import.meta.url);
const state = createModuleGraph(new URL("state.ts", feature)).exports;
const model = { value: "route/reviewer", modelId: "reviewer", providerId: "route", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" };
const config = () => ({ profiles: [], activeProfileId: "", subagentOptimization: true, subagentModel: "legacy", subagentReasoningEffort: "medium",
  subagentRoles: Object.fromEntries([...state.BUILTIN_SUBAGENT_ROLES.map(role => role.id), "default"].map(id => [id, { enabled: true, model: "legacy", reasoningEffort: "high" }])) });

test("custom subagents have unique stable IDs, independent settings and read-only defaults", () => {
  const before = config();
  const next = state.addCustomSubagent(before, model);
  assert.equal(Object.keys(before.subagentRoles).length, 6);
  assert.equal(next.subagentRoles.custom_agent_1.access, "readOnly");
  assert.equal(next.subagentRoles.custom_agent_1.model, "route/reviewer");
  assert.equal(state.validateSubagents(next), null);
  const twice = state.addCustomSubagent(next, model);
  assert.ok(twice.subagentRoles.custom_agent_2);
  const edited = state.updateSubagent(twice, "custom_agent_1", { access: "readWrite", developerInstructions: "实现后返回验证结果" });
  assert.equal(edited.subagentRoles.custom_agent_2.access, "readOnly");
  assert.equal(state.removeCustomSubagent(edited, "custom_agent_1").subagentRoles.custom_agent_1, undefined);
  assert.equal(state.removeCustomSubagent(edited, "codey_worker"), edited);
  assert.equal(state.updateSubagent(edited, "default", { enabled: false }), edited);
});

test("the compatibility default cannot satisfy the last-enabled-role guard", () => {
  let next = state.addCustomSubagent(config(), model);
  for (const { id } of state.BUILTIN_SUBAGENT_ROLES) next = state.updateSubagent(next, id, { enabled: false });
  assert.equal(state.enabledSubagentCount(next), 1);
  assert.equal(state.removeCustomSubagent(next, "custom_agent_1"), next);
  assert.equal(state.updateSubagent(next, "custom_agent_1", { enabled: false }), next);
  next.subagentRoles.custom_agent_1.enabled = false;
  assert.match(state.validateSubagents(next), /至少/);
});

test("model changes preserve supported effort and replace unsupported effort", () => {
  const next = state.addCustomSubagent(config(), model);
  assert.equal(state.selectSubagentModel(next, "codey_worker", model).subagentRoles.codey_worker.reasoningEffort, "high");
  assert.equal(state.selectSubagentModel(next, "codey_worker", { ...model, supportedReasoningEfforts: ["low"] }).subagentRoles.codey_worker.reasoningEffort, "low");
  assert.equal(state.selectSubagentModel(next, "missing", model), next);
});

test("invalid concurrency, empty or oversized definitions and excessive role counts are rejected", () => {
  for (const limit of [0, 65, 1.5, NaN]) assert.match(state.validateSubagents({ ...config(), subagentMaxThreads: limit }), /数量/);
  for (const limit of [1, 64]) assert.equal(state.validateSubagents({ ...config(), subagentMaxThreads: limit }), null);
  let next = state.addCustomSubagent(config());
  assert.equal(next.subagentRoles.custom_agent_1.model, "legacy");
  for (const field of ["name", "description", "developerInstructions"]) {
    assert.ok(state.validateSubagents(state.updateSubagent(next, "custom_agent_1", { [field]: " " })));
    assert.ok(state.validateSubagents(state.updateSubagent(next, "custom_agent_1", { [field]: "字".repeat(4001) })));
  }
  for (let i = 1; i < 32; i++) next = state.addCustomSubagent(next, model);
  assert.equal(state.addCustomSubagent(next, model), next);
  assert.equal(state.removeCustomSubagent(next, "missing"), next);
});

test("controller coordinates the shared draft and blocks edits while busy", () => {
  const h = createControllerHarness(new URL("useSubagentsController.ts", feature), "useSubagentsController");
  const changes = [];
  const props = { config: config(), isBusy: false, subagentModelOptions: [model], onConfigChange: next => changes.push(next) };
  h.render(props).addRole();
  assert.equal(changes.length, 1);
  props.config = changes[0];
  h.render(props).changeMaxThreads(8);
  assert.equal(changes.at(-1).subagentMaxThreads, 8);
  h.render(props).changeMaxThreads(0);
  assert.equal(changes.length, 2);
  h.render(props).changeModel("custom_agent_1", "missing");
  assert.equal(changes.length, 2);
  props.isBusy = true;
  h.render(props).removeRole("custom_agent_1");
  h.render(props).updateRole("custom_agent_1", { name: "ignored" });
  h.render(props).addRole();
  assert.equal(changes.length, 2);
  h.unmount();
});

test("optimization toggle uses the shared draft and preserves role settings", () => {
  const h = createControllerHarness(new URL("useSubagentsController.ts", feature), "useSubagentsController");
  const changes = [];
  const props = { config: config(), isBusy: false, subagentModelOptions: [model], onConfigChange: next => changes.push(next) };
  const controller = h.render(props);
  controller.changeOptimization(false);
  assert.equal(changes[0].subagentOptimization, false);
  assert.equal(changes[0].subagentRoles, props.config.subagentRoles);
  assert.equal(props.config.subagentOptimization, true);
  props.config = { ...changes[0], subagentMaxThreads: 8 };
  assert.equal(h.render(props).changeOptimization, controller.changeOptimization);
  controller.changeOptimization(true);
  assert.equal(changes[1].subagentMaxThreads, 8);
  assert.equal(changes[1].subagentOptimization, true);
  props.isBusy = true;
  h.render(props).changeOptimization(false);
  assert.equal(changes.length, 2);
  h.unmount();
});
