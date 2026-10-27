import assert from "node:assert/strict";
import test from "node:test";
import { autoStubModule, collectElements, createModuleGraph, elementProps, elementType } from "./helpers/jsx-tree.mjs";

const ui = autoStubModule("heroui");
const { exports } = createModuleGraph(new URL("../src/components/ModelCombobox.tsx", import.meta.url), {
  stubs: { "@heroui/react": ui, "@tabler/icons-react": autoStubModule("icons") },
});
const options = [{ value: "official/shared", modelId: "shared", label: "Shared", routeId: "official", routeName: "官方", routePrefix: "官" }];
const render = props => exports.ModelCombobox({ "aria-label": "模型", options, value: "official/shared", onChange() {}, ...props });
const find = (tree, type) => collectElements(tree, element => elementType(element) === type).map(elementProps);

test("model picker uses a selection trigger, retains route labels and ignores cleared selections", () => {
  const changes = [];
  const tree = render({ onChange: value => changes.push(value) });
  assert.equal(elementType(tree), ui.Select);
  assert.equal(find(tree, ui.Select.Trigger).length, 1);
  assert.equal(find(tree, ui.Input).length, 0);
  assert.equal(elementProps(tree).selectedKey, "official/shared");
  const groups = find(tree, ui.ListBox)[0].items;
  assert.equal(groups[0].options[0].textValue, "[官] Shared");
  const renderValue = find(tree, ui.Select.Value)[0].children;
  assert.equal(renderValue({ selectedText: "[官] Shared", isPlaceholder: false }), "[官] Shared");
  elementProps(tree).onSelectionChange(null);
  elementProps(tree).onSelectionChange("official/shared");
  assert.deepEqual(changes, ["official/shared"]);
});

test("unavailable models retain the selected key and warning group", () => {
  const tree = render({ value: "missing-model" });
  assert.equal(elementProps(tree).isInvalid, true);
  assert.equal(elementProps(tree).selectedKey, "missing-model");
  const groups = find(tree, ui.ListBox)[0].items;
  assert.equal(groups[0].label, "不可用模型");
  assert.equal(groups[0].options[0].textValue, "missing-model · 已不可用");
});

test("empty disabled model pickers retain their placeholder and empty state", () => {
  const tree = render({ value: "", options: [], disabled: true, placeholder: "所有线路均暂无模型" });
  assert.equal(elementProps(tree).isDisabled, true);
  assert.equal(elementProps(tree).isInvalid, false);
  assert.equal(elementProps(tree).selectedKey, null);
  assert.equal(find(tree, ui.Select.Value)[0].children({ selectedText: "", isPlaceholder: true }), "所有线路均暂无模型");
  assert.deepEqual(find(tree, ui.ListBox)[0].items, []);
  assert.equal(elementProps(find(tree, ui.ListBox)[0].renderEmptyState()).children, "还没有可用于子代理的模型");
});
