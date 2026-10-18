import assert from "node:assert/strict";
import test from "node:test";

import { readSource } from "./helpers/read-source.mjs";
import { createControllerHarness, installControllerWindow } from "./helpers/controller-harness.mjs";
import {
  autoStubModule,
  collectElements,
  createComponentModule,
  elementProps,
  elementType,
  textContent,
} from "./helpers/jsx-tree.mjs";

const [dialogSource, appSource, stylesSource, operationsSource] = await Promise.all([
  readSource("src/SystemSettingsDialog.tsx"),
  readSource("src/App.tsx"),
  readSource("src/styles.css"),
  readSource("src/OperationsPanel.tsx"),
]);

// 组件库与图标按名字生成桩：断言的是真实组件渲染出的元素树（含事件接线），
// 而不是源码里的字符串，因此把 onClick/onCheckedChange 改成空操作一定会失败。
const ui = autoStubModule("ui");
const hero = autoStubModule("heroui");
const icons = autoStubModule("icon");
const { exports: dialog, reset } = await createComponentModule(
  new URL("../src/SystemSettingsDialog.tsx", import.meta.url),
  { stubs: { "./components/ui": ui, "@heroui/react": hero, "@tabler/icons-react": icons } },
);

const clipboardWrites = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      writeText(value) {
        clipboardWrites.push(value);
        return Promise.resolve();
      },
    },
  },
});

function renderDialog(overrides = {}) {
  reset();
  const calls = { repair: 0, select: 0, autoCheck: [] };
  const props = {
    open: true,
    onOpenChange: () => {},
    container: null,
    appVersion: "1.0.0",
    codexAppVersion: "0.4.0",
    codexAppPath: "/Applications/ChatGPT.app",
    isBusy: false,
    busy: null,
    onRepairCodexConfig: () => {
      calls.repair += 1;
    },
    configRepairNotice: null,
    onSelectCodexDirectory: () => { calls.select++; },
    codeyUpdatePolicy: "stable",
    onCodeyUpdatePolicyChange: (checked) => {
      calls.autoCheck.push(checked);
    },
    ...overrides,
  };
  return { calls, props, tree: dialog.SystemSettingsDialog(props) };
}

const byLabel = (tree, label) =>
  collectElements(tree, (element) => elementProps(element)["aria-label"] === label);
const byText = (tree, text) =>
  collectElements(
    tree,
    (element) =>
      typeof elementProps(element).onClick === "function" &&
      textContent(element).replace(/\s+/g, "") === text,
  );
const policies = (tree) => byLabel(tree, "CodeyX 自动更新");

test("系统设置不再注册设备或显示广播更新设备号", async () => {
  const calls = [];
  const module = await createComponentModule(
    new URL("../src/SystemSettingsDialog.tsx", import.meta.url),
    { stubs: { "./components/ui": ui, "@heroui/react": hero, "@tabler/icons-react": icons, "./api": { invoke: async command => { calls.push(command); return null; } } } },
  );
  const effects = [];
  module.react.useEffect = callback => { effects.push(callback); };
  const tree = module.exports.SystemSettingsDialog(renderDialog().props);
  effects.forEach(effect => effect());
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(textContent(tree), /设备号|尚未登记/);
  assert.equal(byLabel(tree, "复制设备号").length, 0);
});

test("复制路径、修复配置与更新策略都接到真实回调", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  clipboardWrites.length = 0;
  const { calls, tree } = renderDialog();
  const text = textContent(tree);
  assert.match(text, /v1\.0\.0/);
  assert.match(text, /v0\.4\.0/);
  assert.match(text, /\/Applications\/ChatGPT\.app/);

  const [copyButton] = byLabel(tree, "复制 Codex 路径");
  assert.ok(copyButton, "复制按钮必须带 aria-label");
  await elementProps(copyButton).onClick();
  assert.deepEqual(clipboardWrites, ["/Applications/ChatGPT.app"]);

  // 未配置 Codex 路径时复制默认路径，按钮依旧可用。
  clipboardWrites.length = 0;
  const fallback = renderDialog({ codexAppPath: "" });
  await elementProps(byLabel(fallback.tree, "复制 Codex 路径")[0]).onClick();
  assert.deepEqual(clipboardWrites, ["/Applications/ChatGPT.app"]);

  const [repairButton] = byText(tree, "修复");
  assert.ok(repairButton, "修复按钮必须存在");
  assert.equal(elementProps(repairButton).disabled, false);
  elementProps(repairButton).onClick();
  assert.equal(calls.repair, 1, "点击修复必须触发修复回调");
  elementProps(byLabel(tree, "重新选择 Codex 目录")[0]).onClick();
  assert.equal(calls.select, 1);

  const [slider] = policies(tree);
  assert.ok(slider);
  assert.equal(elementType(slider), ui.Switch);
  assert.equal(elementProps(slider).checked, true);
  assert.equal(elementProps(slider).disabled, false);
  assert.doesNotMatch(text, /实验版/);
  for (const checked of [false, true]) elementProps(slider).onCheckedChange(checked);
  assert.deepEqual(calls.autoCheck, ["off", "stable"]);
  assert.equal(elementProps(slider).checked, true);
  assert.ok(
    collectElements(tree, (e) => /仍可手动检查稳定版/.test(elementProps(e).content ?? "")).length > 0 ||
    /仍可手动检查稳定版/.test(textContent(tree)),
  );
});

test("更新策略跟随配置、修复中显示进行态", () => {
  const off = renderDialog({ codeyUpdatePolicy: "off" });
  assert.equal(elementProps(policies(off.tree)[0]).checked, false);
  assert.match(textContent(off.tree), /不更新/);

  const busy = renderDialog({ busy: "repair-codex-config", isBusy: true });
  const [busyButton] = byText(busy.tree, "修复中…");
  assert.ok(busyButton, "修复进行中必须显示进行态");
  assert.equal(elementProps(busyButton).disabled, true);
  assert.equal(elementProps(policies(busy.tree)[0]).disabled, true);
  assert.equal(elementProps(byLabel(busy.tree, "重新选择 Codex 目录")[0]).disabled, true);
  assert.equal(busy.calls.repair, 0);
});

test("系统设置不出现冗余状态文案", () => {
  const { tree } = renderDialog();
  const text = textContent(tree);
  assert.doesNotMatch(text, /当前应用/);
  assert.doesNotMatch(text, /运行中/);
  assert.doesNotMatch(text, /检查配置文件并修复异常/);
  assert.doesNotMatch(text, /后台每隔 30 分钟自动检查新版本/);
  assert.doesNotMatch(dialogSource, /检查配置文件并修复异常/);
});

test("App 把系统设置对话框接到修复命令与自动更新保存入口", () => {
  assert.match(appSource, /onRepairCodexConfig=\{askRepairCodexConfig\}/);
  assert.match(appSource, /onSelectCodexDirectory=\{selectCodexDirectory\}/);
  assert.match(appSource, /onCodeyUpdatePolicyChange=\{changeUpdatePolicy\}/);
  assert.match(appSource, /codeyUpdatePolicy=\{config\.codeyUpdatePolicy\}/);
  assert.match(appSource, /useRuntimeMaintenanceController\(/);
  assert.match(appSource, /className="sidebar-footer-bar"/);
  assert.match(appSource, /className="sidebar-footer-left"/);
  assert.doesNotMatch(appSource, /className="sidebar-footer-brand"/);
  assert.match(appSource, /className="sidebar-footer-version font-mono"/);
  assert.match(appSource, /<IconCircleArrowUp size=\{15\}/);
  assert.match(appSource, /handleFooterUpdateClick/);
  assert.match(appSource, /className="sidebar-footer-right"/);
  assert.match(appSource, /setSystemSettingsOpen\(true\)/);
  assert.match(appSource, /<SystemSettingsDialog[\s\S]*open=\{systemSettingsOpen\}/);
});

test("更新开关直接修改草稿，无需实验版风险确认", async t => {
  installControllerWindow(t);
  let confirmation = null;
  const options = { active: true, embedded: true, configLoaded: true, codeyUpdatePolicy: "stable", isBusy: false,
    config: { codeyUpdatePolicy: "stable" }, onConfigChange: value => { options.config = value; },
    setBusy() {}, setNotice() {}, setConfirmation: value => { confirmation = value; }, beforeInstall: async () => {} };
  const h = createControllerHarness(new URL("../src/features/app-updates/useAppUpdatesController.ts", import.meta.url), "useAppUpdatesController", {
    "../../api": { invoke: async () => null },
  });
  const change = h.render(options).changeUpdatePolicy;
  change("off");
  assert.equal(options.config.codeyUpdatePolicy, "off");
  assert.equal(confirmation, null);
  h.render(options);
  confirmation = null;
  change("stable");
  assert.equal(options.config.codeyUpdatePolicy, "stable");
  assert.equal(confirmation, null);
  h.unmount();
});

test("目录重新选择显示忙碌和保留原目录的错误反馈", () => {
  const busy = renderDialog({ isBusy: true, busy: "select-codex-directory" });
  const button = byLabel(busy.tree, "重新选择 Codex 目录")[0];
  assert.equal(elementProps(button).disabled, true);
  assert.match(textContent(button), /识别中/);
  const failed = renderDialog({ codexDirectoryNotice: { tone: "error", text: "识别失败，已保留原目录" } });
  assert.match(textContent(failed.tree), /识别失败，已保留原目录/);
  assert.match(textContent(failed.tree), /\/Applications\/ChatGPT.app/);
});

test("styles define sidebar footer layout and responsive behavior", () => {
  assert.match(stylesSource, /\.sidebar-footer-bar\s*\{/);
  assert.match(stylesSource, /\.sidebar-footer-left\s*\{/);
  assert.match(stylesSource, /\.sidebar-footer-right\s*\{/);
  assert.match(stylesSource, /\.sidebar-footer-version\s*\{/);
});

test("OperationsPanel removes redundant top hero card and config repair button", () => {
  assert.doesNotMatch(operationsSource, /operations-hero-card/);
  assert.doesNotMatch(operationsSource, /Codex 运行状态/);
  assert.doesNotMatch(operationsSource, /修复 Codex 配置/);
  assert.doesNotMatch(operationsSource, /expanded-tray-toolbar/);
  assert.match(operationsSource, /已生效 \$\{enabledOptimizationFeatures\.length\} 项功能/);
});
