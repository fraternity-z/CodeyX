import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { autoStubModule, collectElements, createModuleGraph, textContent } from "./helpers/jsx-tree.mjs";

const panel = await readFile(new URL("../src/features/official-accounts/OfficialAccountsPanel.tsx", import.meta.url), "utf8");
const controllerSource = await readFile(new URL("../src/features/official-accounts/useOfficialAccountsController.ts", import.meta.url), "utf8");
const models = await readFile(new URL("../src/ModelSection.tsx", import.meta.url), "utf8");
const layout = await readFile(new URL("../src/SettingsLayout.tsx", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("设置页只在首次打开对应菜单后挂载模块", () => {
  assert.match(layout, /const \[visitedPages, setVisitedPages\]/);
  assert.match(layout, /visitedPages\.has\(page\.id\) && \(/);
});

test("线路与模型菜单把激活状态透传到官方账号面板", () => {
  assert.match(app, /models: \(active\) => \(/);
  assert.match(app, /<ModelSection\s+active=\{active && \(!embedded \|\| modalVisible\)\}/);
  const section = models.match(/<OfficialAccountsPanel[\s\S]*?\/>/)?.[0];
  assert.ok(section, "应在 ModelSection 内渲染官方账号面板");
  assert.match(section, /active=\{active\}/);
  assert.match(models, /active: boolean;/);
});

test("官方账号面板将额度生命周期交给 controller，保留手动刷新入口", () => {
  assert.match(panel, /useOfficialAccountsController\(\{ active, isBusy, onAccountsLoaded, onAccountsChanged, onNotice \}\)/);
  assert.match(controllerSource, /useOfficialAccountUsageController\(\{/);
  assert.doesNotMatch(panel, /query_official_account_usage|refresh_official_account_routes/);
  assert.match(panel, /onClick=\{\(\) => void refreshUsage\(account\.id, true\)\}/);
});

test("账号卡片展示 controller 的套餐与加载态，刷新按钮调用对应账号动作", () => {
  const calls = [];
  let options;
  const controller = {
    accounts: [{ id: "account-a", planType: "pro", email: "account@example.test" }],
    usages: { "account-a": { status: "ok", planType: "plus" } },
    usagePending: {},
    manualInput: "", login: null, siwcLogin: null, disabled: false,
    refreshUsage: (...args) => calls.push(args),
  };
  const graph = createModuleGraph(new URL("../src/features/official-accounts/OfficialAccountsPanel.tsx", import.meta.url), {
    autoStub: true,
    stubs: {
      "../../components/ui": autoStubModule("ui"),
      "./useOfficialAccountsController": { useOfficialAccountsController(value) { options = value; return controller; } },
    },
  });
  const render = (active) => {
    graph.restart();
    return graph.exports.OfficialAccountsPanel({ active, isBusy: false, officialAccountAvailable: true,
      popupContainer: null, onAccountsChanged() {}, onNotice() {} });
  };
  const tree = render(true);
  assert.equal(options.active, true);
  assert.match(textContent(tree), /Plus/);
  const button = collectElements(tree, (node) => node.props["aria-label"] === "刷新额度")[0];
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.deepEqual(calls, [["account-a", true]]);
  controller.usagePending = { "account-a": 1 };
  const loading = render(false);
  assert.equal(options.active, false);
  assert.equal(collectElements(loading, (node) => node.props["aria-label"] === "正在刷新额度")[0].props.disabled, true);
});
