import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { autoStubModule, collectElements, createModuleGraph, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const state = createModuleGraph(new URL("../src/features/prompt-optimization/state.ts", import.meta.url)).exports;
const draft = { enabled: true, mode: "manual", baseUrl: "https://api.example.com/v1", apiKey: "", apiKeyConfigured: true,
  clearApiKey: false, model: "test-model", upstreamProtocol: "openaiResponses", instruction: "保留原始目标" };

function fixture(extra = {}, component = false) {
  const calls = [], changes = [], notices = [], feedback = [];
  const ui = autoStubModule("ui"), header = autoStubModule("header"), manual = autoStubModule("manual"), routed = autoStubModule("routed");
  const heroui = { Tabs: autoStubModule("heroui").Tabs, toast: {
    success: text => feedback.push({ tone: "success", text }), danger: text => feedback.push({ tone: "error", text }),
  } };
  const options = { active: true, config: { settingsRevision: 1, localRouterEnabled: true, retained: "shared draft", promptOptimization: { ...draft } },
    isBusy: false, subagentModelOptions: [], onNotice: notice => notices.push(notice), onFeedback: notice => feedback.push(notice),
    onConfigChange: next => { changes.push(next); options.config = next; }, ...extra };
  const h = createControllerHarness(new URL(component ? "../src/PromptOptimizationCard.tsx" : "../src/features/prompt-optimization/usePromptOptimizationController.ts", import.meta.url),
    component ? "PromptOptimizationCard" : "usePromptOptimizationController", {
      "../../api": { invoke(command, args) { const call = { command, args, ...deferred() }; calls.push(call); return call.promise; } },
      "../../components/ui": ui, "../../SettingsPageHeader": header, "../../components/ManualModelCombobox": manual,
      "../../components/ModelCombobox": routed, "@tabler/icons-react": autoStubModule("icons"), "@heroui/react": heroui,
    });
  return { ...h, calls, changes, notices, feedback, options, ui, header, manual, routed, heroui,
    edit(patch) { options.config = { ...options.config, promptOptimization: { ...options.config.promptOptimization, ...patch } }; },
    render: () => h.render(options) };
}

test("提示词优化校验保留路由、已保存密钥和关闭状态的语义", () => {
  const validate = (patch, router = true) => state.validatePromptOptimization({ ...draft, ...patch }, router);
  assert.equal(validate({}).testDraftValid, true);
  for (const baseUrl of ["", "  ", "invalid", "file:///tmp", "https://user:pass@example.com"]) {
    assert.ok(validate({ baseUrl }).baseUrlError); assert.equal(validate({ baseUrl }).connectionDraftValid, false);
  }
  assert.equal(validate({ baseUrl: " https://api.example.com/v1 " }).baseUrlError, "");
  assert.equal(validate({ apiKeyConfigured: false, apiKey: "  " }).apiKeyError, "请输入 API Key");
  assert.equal(validate({ clearApiKey: true }).connectionDraftValid, false);
  assert.equal(validate({ apiKeyConfigured: false, apiKey: "test-only-key" }).connectionDraftValid, true);
  assert.equal(validate({ model: " " }).modelError, "请选择或填写模型");
  assert.equal(validate({ model: " " }).connectionDraftValid, true);
  assert.equal(validate({ mode: "codeyRoute", baseUrl: "invalid", apiKeyConfigured: false }).testDraftValid, true);
  assert.equal(validate({ mode: "codeyRoute", model: " " }).modelError, "请选择 CodeyX 路由模型");
  assert.equal(validate({ mode: "codeyRoute" }, false).connectionDraftValid, false);
  const disabled = validate({ enabled: false, model: "", baseUrl: "", apiKeyConfigured: false });
  assert.equal(disabled.baseUrlError, ""); assert.equal(disabled.apiKeyError, ""); assert.equal(disabled.modelError, "");
});

test("测试结果保持 HTTP 成功、失败和缺省提示，不展示成功响应正文", () => {
  for (const [input, expected] of [
    [undefined, { tone: "success", text: "连接成功" }],
    [{ httpStatus: 200, responsePreview: "不应展示" }, { tone: "success", text: "连接成功（HTTP 200）" }],
    [{ httpStatus: 399 }, { tone: "success", text: "连接成功（HTTP 399）" }],
    [{ httpStatus: 400, responsePreview: "  请求无效  " }, { tone: "error", text: "连接失败（HTTP 400）：请求无效" }],
    [{ httpStatus: 503, responsePreview: "  " }, { tone: "error", text: "连接失败（HTTP 503）" }],
  ]) assert.deepEqual(state.promptOptimizationTestFeedback(input), expected);
});

test("模型读取与连接测试经请求层传递当前草稿，共用同步防重锁", async t => {
  const browser = installControllerWindow(t);
  const h = fixture(); const c = h.render();
  const models = c.runFetchModels(); await c.runFetchModels(); await c.runTest();
  assert.equal(h.calls.length, 1); assert.equal(h.render().fetchingModels, true);
  assert.equal(h.calls[0].command, "fetch_prompt_optimization_models");
  assert.deepEqual(h.calls[0].args, { config: draft });
  h.calls[0].resolve({ models: ["model-a", "model-b"] }); await models;
  assert.deepEqual(h.render().cloudModels, ["model-a", "model-b"]);
  assert.deepEqual(h.feedback, [{ tone: "success", text: "已获取 2 个模型" }]);
  const work = h.render().runTest(); await h.render().runTest(); await h.render().runFetchModels();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].command, "test_prompt_optimization");
  assert.deepEqual(h.calls[1].args, { config: draft }); assert.equal(h.render().testing, true);
  h.calls[1].resolve({ result: { httpStatus: 200 } }); await work;
  assert.equal(h.render().testing, false); assert.deepEqual(h.feedback.at(-1), { tone: "success", text: "连接成功（HTTP 200）" });
  assert.deepEqual(h.notices, [{ tone: "info", text: "" }, { tone: "info", text: "" }]);
  assert.equal(h.changes.length, 0); assert.equal(browser.timers.size, 0); h.unmount();
});

test("隐藏、全局忙碌、关闭功能和无效草稿不发请求，路由模式禁止获取手动列表", async t => {
  installControllerWindow(t);
  for (const mode of ["hidden", "busy", "disabled", "url", "key", "router"]) {
    const h = fixture({ active: mode !== "hidden", isBusy: mode === "busy" });
    if (mode === "disabled") h.edit({ enabled: false });
    if (mode === "url") h.edit({ baseUrl: "bad-url" });
    if (mode === "key") h.edit({ apiKeyConfigured: false });
    if (mode === "router") { h.edit({ mode: "codeyRoute" }); h.options.config.localRouterEnabled = false; }
    await h.render().runFetchModels(); await h.render().runTest(); assert.equal(h.calls.length, 0, mode); h.unmount();
  }
  const h = fixture(); h.edit({ model: " " }); await h.render().runTest(); assert.equal(h.calls.length, 0);
  const work = h.render().runFetchModels(); h.calls[0].resolve({}); await work;
  h.edit({ mode: "codeyRoute", model: "route-model" }); await h.render().runFetchModels(); assert.equal(h.calls.length, 1);
  const routed = h.render().runTest(); h.calls[1].resolve({}); await routed;
  assert.equal(h.calls[1].args.config.mode, "codeyRoute"); h.unmount();
});

test("草稿仍由应用拥有，稳定动作合并最新配置，失败保留草稿与已取得列表", async t => {
  installControllerWindow(t);
  const h = fixture(); const c = h.render();
  const first = c.runFetchModels(); h.calls[0].resolve({ models: ["existing"] }); await first; h.render();
  h.options.config = { ...h.options.config, retained: "new shared draft" }; h.render();
  c.updateOptimization({ instruction: "新指令" }); h.render();
  assert.equal(h.options.config.retained, "new shared draft"); assert.equal(h.options.config.promptOptimization.instruction, "新指令");
  assert.deepEqual(h.render().cloudModels, ["existing"]);
  const config = h.options.config; const failed = h.render().runFetchModels(); h.calls.at(-1).reject(new Error("获取失败")); await failed;
  assert.equal(h.options.config, config); assert.deepEqual(h.render().cloudModels, ["existing"]);
  assert.deepEqual(h.feedback.at(-1), { tone: "error", text: "获取失败" });
  const testWork = h.render().runTest(); h.calls.at(-1).reject(new Error("测试失败")); await testWork;
  assert.equal(h.options.config, config); assert.deepEqual(h.feedback.at(-1), { tone: "error", text: "测试失败" });
  c.handleApiKeyChange("test-only-key"); h.render(); assert.equal(h.options.config.promptOptimization.clearApiKey, false);
  assert.deepEqual(h.render().cloudModels, []); c.handleApiKeyChange(""); h.render();
  assert.equal(h.options.config.promptOptimization.apiKey, ""); assert.equal(h.render().connectionDraftValid, true);
  c.changeMode("codeyRoute"); h.render(); assert.equal(h.options.config.promptOptimization.mode, "codeyRoute");
  const count = h.changes.length; c.changeMode("codeyRoute"); assert.equal(h.changes.length, count);
  h.options.active = false; h.render(); c.updateOptimization({ instruction: "ignored" }); c.changeMode("manual");
  h.options.active = true; h.options.isBusy = true; h.render(); c.updateOptimization({ instruction: "ignored" }); c.changeMode("manual");
  assert.equal(h.changes.length, count); h.unmount(); c.updateOptimization({ instruction: "ignored" }); assert.equal(h.changes.length, count);
});

test("空目录报错且允许显式重试，不覆盖手动模型", async t => {
  installControllerWindow(t);
  const h = fixture();
  for (const response of [{}, { models: [] }]) {
    const work = h.render().runFetchModels(); h.calls.at(-1).resolve(response); await work;
    assert.deepEqual(h.feedback.at(-1), { tone: "error", text: "服务端没有返回可用模型" });
    assert.equal(h.render().optimization.model, "test-model");
  }
  const work = h.render().runTest(); h.calls.at(-1).resolve({ result: { httpStatus: 401, responsePreview: "测试凭据无效" } }); await work;
  assert.deepEqual(h.feedback.at(-1), { tone: "error", text: "连接失败（HTTP 401）：测试凭据无效" }); h.unmount();
});

test("连接配置或保存基线变化作废旧成功和错误，旧 finally 只释放自身锁", async t => {
  installControllerWindow(t);
  for (const patch of [{ baseUrl: "https://other.example.com" }, { upstreamProtocol: "anthropicMessages" }, { apiKey: "test-only-key" },
    { apiKeyConfigured: false }, { clearApiKey: true }, { mode: "codeyRoute" }, { enabled: false }, "revision", "router"]) {
    for (const kind of ["runFetchModels", "runTest"]) for (const failed of [false, true]) {
      const h = fixture(); const work = h.render()[kind]();
      if (patch === "revision") h.options.config = { ...h.options.config, settingsRevision: 2 };
      else if (patch === "router") h.options.config = { ...h.options.config, localRouterEnabled: false };
      else h.edit(patch);
      await h.render()[kind](); assert.equal(h.calls.length, 1);
      if (failed) h.calls[0].reject(new Error("stale failure")); else h.calls[0].resolve({ models: ["stale"], result: { httpStatus: 200 } });
      await work; const c = await h.flush();
      assert.deepEqual(c.cloudModels, []); assert.deepEqual(h.feedback, []); assert.equal(c.testing || c.fetchingModels, false);
      assert.equal(h.changes.length, 0); h.unmount();
    }
  }
});

test("修改模型或指令只作废旧测试，候选目录读取仍可完成", async t => {
  installControllerWindow(t);
  for (const patch of [{ model: "new-model" }, { instruction: "新指令" }]) {
    for (const kind of ["runFetchModels", "runTest"]) {
      const h = fixture(); const work = h.render()[kind](); h.edit(patch); h.render();
      h.calls[0].resolve({ models: ["available"], result: { httpStatus: 200 } }); await work;
      assert.deepEqual(h.render().cloudModels, kind === "runFetchModels" ? ["available"] : []);
      assert.equal(h.feedback.length, kind === "runFetchModels" ? 1 : 0); h.unmount();
    }
  }
});

test("隐藏重开保留草稿、目录和在途锁，旧结果不弹提示且不自动重放", async t => {
  installControllerWindow(t);
  for (const kind of ["runFetchModels", "runTest"]) for (const failed of [false, true]) {
    const h = fixture(); const first = h.render().runFetchModels(); h.calls[0].resolve({ models: ["retained"] }); await first;
    h.feedback.length = 0; const work = h.render()[kind]();
    h.options.active = false; h.render(); h.options.active = true; h.render();
    await h.render()[kind](); assert.equal(h.calls.length, 2);
    if (failed) h.calls[1].reject(new Error("late")); else h.calls[1].resolve({ models: ["late"], result: { httpStatus: 200 } });
    await work; await h.flush(); assert.equal(h.calls.length, 2);
    assert.deepEqual(h.render().cloudModels, ["retained"]); assert.deepEqual(h.feedback, []); assert.equal(h.changes.length, 0);
    const retry = h.render()[kind](); assert.deepEqual(h.calls[2].args, { config: draft });
    h.calls[2].resolve({ models: ["current"], result: { httpStatus: 200 } }); await retry;
    assert.equal(h.feedback.length, 1); h.unmount();
  }
});

test("超时只反馈一次，迟到结果不能覆盖显式重试或提前清除新忙碌状态", async t => {
  const browser = installControllerWindow(t);
  for (const kind of ["runFetchModels", "runTest"]) for (const failed of [false, true]) {
    const h = fixture(); const old = h.render()[kind](); browser.tick(); await old;
    assert.equal(h.feedback.length, 1); assert.match(h.feedback[0].text, /超时/); assert.equal(h.calls.length, 1);
    const current = h.render()[kind]();
    if (failed) h.calls[0].reject(new Error("too late")); else h.calls[0].resolve({ models: ["stale"], result: { httpStatus: 200 } });
    await h.flush(); assert.equal(h.render().testing || h.render().fetchingModels, true); assert.equal(h.feedback.length, 1);
    h.calls[1].resolve({ models: ["current"], result: { httpStatus: 200 } }); await current;
    assert.equal(h.feedback.length, 2); assert.equal(browser.timers.size, 0); h.unmount();
  }
});

test("卸载清理超时计时器，迟到成功、错误及 finally 均不回写", async t => {
  const browser = installControllerWindow(t);
  for (const kind of ["runFetchModels", "runTest"]) for (const failed of [false, true]) {
    const h = fixture(); const work = h.render()[kind](); const notices = h.notices.length;
    h.unmount(); assert.equal(browser.timers.size, 0);
    if (failed) h.calls[0].reject(new Error("late")); else h.calls[0].resolve({ models: ["late"], result: { httpStatus: 200 } });
    await work; await h.flush(); assert.equal(h.writesAfterUnmount, 0); assert.deepEqual(h.feedback, []); assert.equal(h.notices.length, notices);
  }
});

test("视图接线保留密码显隐、连接校验、模型获取、测试提示和草稿编辑", async t => {
  installControllerWindow(t);
  const h = fixture({}, true);
  const find = (type, predicate = () => true) => collectElements(h.render(), node => elementType(node) === type && predicate(elementProps(node), node))[0];
  const button = label => find(h.ui.Button, (_, node) => textContent(node) === label);
  const key = () => find(h.ui.PasswordInput);
  assert.equal(elementProps(key()).visibility, false); elementProps(key()).onVisibilityChange(); assert.equal(elementProps(key()).visibility, true);
  h.options.config = { ...h.options.config, settingsRevision: 2 }; assert.equal(elementProps(key()).visibility, false);
  elementProps(key()).onChange({ target: { value: "test-only-key" } }); assert.equal(h.options.config.promptOptimization.apiKey, "test-only-key");
  elementProps(find(h.ui.Input)).onChange({ target: { value: "invalid-url" } });
  assert.equal(elementProps(button("获取列表")).disabled, true); assert.match(textContent(h.render()), /API 地址格式无效/);
  elementProps(find(h.ui.Input)).onChange({ target: { value: "https://api.example.com/v1" } });
  elementProps(find(h.ui.Select)).onChange("anthropicMessages");
  elementProps(button("获取列表")).onClick(); h.render(); assert.equal(elementProps(button("测试 API 连通性")).disabled, true);
  h.calls[0].resolve({ models: ["visible-model"] }); await h.flush();
  assert.deepEqual(elementProps(find(h.manual.ManualModelCombobox)).options, ["visible-model"]);
  elementProps(find(h.manual.ManualModelCombobox)).onChange("chosen-model");
  elementProps(find(h.ui.TextArea)).onChange({ target: { value: "用户草稿" } });
  elementProps(button("测试 API 连通性")).onClick(); h.render();
  assert.equal(h.calls[1].args.config.model, "chosen-model"); assert.equal(h.calls[1].args.config.instruction, "用户草稿");
  h.calls[1].resolve({ result: { httpStatus: 503 } }); await h.flush();
  assert.deepEqual(h.feedback.at(-1), { tone: "error", text: "连接失败（HTTP 503）" });
  elementProps(find(h.heroui.Tabs)).onSelectionChange("codeyRoute"); h.render();
  elementProps(find(h.routed.ModelCombobox)).onChange("route-model");
  elementProps(button("测试路由连通性")).onClick(); h.calls[2].resolve({ result: { httpStatus: 200 } }); await h.flush();
  assert.deepEqual(h.feedback.at(-1), { tone: "success", text: "连接成功（HTTP 200）" });
  const actions = elementProps(find(h.header.SettingsPageHeader)).actions;
  elementProps(actions).onCheckedChange(false); assert.match(textContent(h.render()), /提示词优化已关闭/); h.unmount();
});
