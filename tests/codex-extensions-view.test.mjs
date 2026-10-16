import assert from "node:assert/strict";
import test from "node:test";
import { autoStubModule, collectElements, createModuleGraph, createStub, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const ui = autoStubModule("ui");
const components = Object.fromEntries(["ExtensionScope", "ExtensionFilters", "ExtensionList", "ExtensionEditor", "ConfirmationDialog", "SkillCacheDialog"].map(name => [name, createStub(name)]));
const common = { "../../components/ui": ui, "@tabler/icons-react": autoStubModule("icon"), "@heroui/react": { toast: { success() {}, warning() {} } },
  "../../SettingsPageHeader": { SettingsPageHeader: createStub("SettingsPageHeader") },
  "./ExtensionToolbar": components, "./ExtensionList": components, "./ExtensionEditor": components, "./ConfirmationDialog": components, "./SkillCacheDialog": components };
const propsOf = (tree, name) => elementProps(collectElements(tree, node => elementType(node) === components[name])[0]);

test("扩展页面将编辑、比对、确认和筛选事件接到 controller", () => {
  const calls = [];
  const action = name => (...args) => { calls.push([name, ...args]); };
  const controller = {
    inventory: { revision: "r1", warnings: [] }, scope: { kind: "user" }, entries: [], filtered: [], currentPage: { entries: [], page: 1, pages: 1 },
    selected: [], query: "", filter: "all", source: "all", sort: "name", projectPath: "", projectMode: false,
    draft: { kind: "mcp", id: "fixture", content: "{}", isNew: true }, comparison: { content: "latest", revision: "r2" },
    confirmation: { title: "确认", description: "fixture" }, discard: null, busy: false, loading: false, saving: false, error: "", notice: "", noticeSeq: 0,
    ...Object.fromEntries(["refresh", "changeMode", "setProjectPath", "pickProject", "changeScope", "setQuery", "setFilter", "setSource", "setSort", "clearFilters", "selectPage", "selectEntry", "onAction", "changeDraft", "save", "closeDraft", "pickSkill", "loadLatest", "adoptComparison", "cancelConfirmation", "confirmAction"].map(name => [name, action(name)])),
  };
  const graph = createModuleGraph(new URL("../src/features/codex-extensions/CodexExtensionsPage.tsx", import.meta.url), {
    stubs: { ...common, "./useExtensionsPageController": { useExtensionsPageController: options => { assert.equal(options.active, true); assert.equal(typeof options.onDownload, "function"); return controller; } } },
  });
  const tree = graph.exports.CodexExtensionsPage({ kind: "mcp", active: true });
  const editor = propsOf(tree, "ExtensionEditor");
  editor.onChange({ content: "draft" }); editor.onSave(); editor.onCancel(); editor.onPick(); editor.onReload();
  const filters = propsOf(tree, "ExtensionFilters"); filters.onQuery("query"); filters.onClear();
  const scope = propsOf(tree, "ExtensionScope"); scope.onMode(true); scope.onRead(); scope.onPick();
  const list = propsOf(tree, "ExtensionList"); list.onAction("edit", { id: "fixture" }); list.onSelect("fixture");
  propsOf(tree, "ConfirmationDialog").onConfirm();
  const compare = collectElements(tree, node => elementType(node) === ui.Button && textContent(node).includes("已比对"))[0];
  elementProps(compare).onClick();
  assert.deepEqual(calls.map(call => call[0]), ["changeDraft", "save", "closeDraft", "pickSkill", "loadLatest", "setQuery", "clearFilters", "changeMode", "changeScope", "pickProject", "onAction", "selectEntry", "confirmAction", "adoptComparison"]);
});

test("缓存弹窗将读取、刷新和确认删除接到 controller，删除时禁止关闭", () => {
  const calls = [];
  const entry = { id: "cache", name: "fixture", sourcePath: "/fixture", description: "fixture" };
  const state = { cache: { skills: [entry], warnings: [] }, busy: "", error: "", notice: "", blocked: false,
    confirmation: entry, document: null, unavailable: false, refresh: () => calls.push("refresh"), read: item => calls.push(["read", item.id]),
    askRemove: item => calls.push(["askRemove", item.id]), remove: () => calls.push("remove"), cancelRemove: () => calls.push("cancel") };
  const graph = createModuleGraph(new URL("../src/features/codex-extensions/SkillCacheDialog.tsx", import.meta.url), {
    stubs: { ...common, "./useSkillCacheController": { useSkillCacheController: () => state } },
  });
  let closed = 0;
  const tree = graph.exports.SkillCacheDialog({ open: true, onClose: () => closed++ });
  for (const label of ["刷新缓存", "查看", "删除"]) {
    const button = collectElements(tree, node => elementType(node) === ui.Button && textContent(node) === label)[0];
    elementProps(button).onClick();
  }
  propsOf(tree, "ConfirmationDialog").onConfirm();
  assert.deepEqual(calls, ["refresh", ["read", "cache"], ["askRemove", "cache"], "remove"]);
  const dialog = collectElements(tree, node => elementType(node) === ui.Dialog)[0];
  elementProps(dialog).onOpenChange(false); assert.equal(closed, 0);
  assert.equal(graph.exports.SkillCacheDialog({ open: false, onClose() {} }), null);
});
