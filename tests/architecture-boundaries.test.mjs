import assert from "node:assert/strict";
import test from "node:test";
import { checkArchitecture } from "../scripts/check-architecture.mjs";

test("功能视图、controller、请求和纯逻辑遵守依赖方向", () => {
  assert.deepEqual(checkArchitecture({
    "src/features/demo/index.ts": 'export { Demo } from "./DemoView";',
    "src/features/demo/DemoView.tsx": 'import { useDemoController } from "./useDemoController"; export const Demo = () => <div />;',
    "src/features/demo/useDemoController.ts": 'import { request } from "./requests"; import type { Demo } from "./DemoView";',
    "src/features/demo/requests.ts": 'import { invoke } from "../../api"; export const request = () => invoke("demo");',
    "src/features/demo/state.ts": 'export const select = (items: string[]) => items.slice();',
  }), []);
});

test("手机传输与 WebSocket 只能由功能请求层调用，别名和动态导入也受约束", () => {
  for (const file of ["Workspace.tsx", "useRemoteWorkspaceController.ts", "state.ts"]) {
    for (const source of [
      'import { remoteRequest as send } from "../../remote/transport";',
      'import("../../remote/transport.js");',
      'remoteRequest("/remote/action");',
      'transport.remoteRequest("/remote/session");',
      'new WebSocket("wss://example.test");',
      'new window.WebSocket("wss://example.test");',
    ]) assert.ok(checkArchitecture({ [`src/features/remote-workspace/${file}`]: source }).length, `${file}: ${source}`);
  }
  assert.deepEqual(checkArchitecture({
    "src/features/remote-workspace/requests.ts": 'import { remoteRequest } from "../../remote/transport"; remoteRequest("/remote/session"); new WebSocket("wss://example.test");',
    "src/remote/workspace.tsx": 'export { Workspace } from "../features/remote-workspace";',
  }), []);
});

test("新增功能自动纳入检查，别名导入和动态导入不能绕开请求边界", () => {
  for (const source of ['import { invoke as send } from "../../api";', 'import("./requests");', 'export { request } from "./requests";', 'fetch("/api");']) {
    assert.ok(checkArchitecture({ "src/features/new/DemoView.tsx": source }).length, source);
  }
  assert.match(checkArchitecture({ "src/features/new/useDemoController.ts": 'import { invoke } from "../../api";' }).join(), /本功能 requests/);
  assert.match(checkArchitecture({ "src/features/new/state.ts": 'window.localStorage.setItem("x", "y");' }).join(), /副作用/);
  assert.match(checkArchitecture({ "src/features/new/requests.ts": 'import { useState } from "react";' }).join(), /不能依赖 React/);
  assert.match(checkArchitecture({ "src/features/new/state.ts": 'const storage = window.localStorage;' }).join(), /副作用/);
  assert.match(checkArchitecture({
    "src/features/new/useDemoController.ts": 'import { Demo } from "./DemoView";',
    "src/features/new/DemoView.tsx": 'export const Demo = () => <div />;',
  }).join(), /不能依赖视图/);
  assert.deepEqual(checkArchitecture({ "src/features/new/types.ts": 'export { type Item } from "../other/types";' }), []);
});

test("跨功能内部依赖、运行时环和 App 新业务命令会被阻止", () => {
  assert.match(checkArchitecture({ "src/App.tsx": 'import { foo } from "./features/demo/state"; invoke("delete_route");' }).join(), /公开入口/);
  assert.match(checkArchitecture({ "src/App.tsx": 'invoke("delete_route");' }).join(), /不得新增业务命令/);
  for (const command of ["load_codey_config", "save_codey_config", "codex_extensions", "plugin_marketplace_status", "restart_codey", "repair_plugin_marketplace", "prepare_computer_use", "repair_main_process_injection", "repair_codex_config", "clear_diagnostic_storage"]) {
    assert.match(checkArchitecture({ "src/App.tsx": `invoke("${command}");` }).join(), /不得新增业务命令/);
  }
  assert.deepEqual(checkArchitecture({ "src/App.tsx": 'import { useConfigurationController } from "./features/configuration";' }), []);
  for (const source of ['import { invoke as send } from "./api";', 'import("./api");', 'require("./api");', 'export { invoke } from "./api.ts";']) {
    assert.match(checkArchitecture({ "src/App.tsx": source }).join(), /不得直接依赖后端传输/);
  }
  assert.match(checkArchitecture({ "src/App.tsx": 'fetch("/api/load_codey_config");' }).join(), /不得新增业务命令/);
  assert.match(checkArchitecture({
    "src/features/demo/a.ts": 'import { b } from "./b";',
    "src/features/demo/b.ts": 'import { a } from "./a";',
  }).join(), /循环依赖/);
});

test("扩展管理不再豁免视图请求、纯逻辑副作用和内部依赖检查", () => {
  assert.match(checkArchitecture({ "src/features/codex-extensions/SkillCacheDialog.tsx": 'import { getSkillCacheRequests } from "./requests";' }).join(), /视图不能依赖请求层/);
  assert.match(checkArchitecture({ "src/features/codex-extensions/state.ts": 'document.createElement("a");' }).join(), /副作用/);
  assert.match(checkArchitecture({ "src/App.tsx": 'import { readInventory } from "./features/codex-extensions/requests";' }).join(), /公开入口/);
});

test("JavaScript 扩展名、目录视图和 import equals 不能绕开边界", () => {
  for (const source of [
    'import { request } from "./requests.js";',
    'import request = require("./requests");',
    'import(`./requests`);',
  ]) {
    assert.match(checkArchitecture({ "src/features/demo/DemoView.tsx": source }).join(), /视图不能依赖请求层/);
  }
  assert.match(checkArchitecture({
    "src/features/demo/useDemoController.ts": 'import { Control } from "../../components/control";',
    "src/components/control/index.tsx": 'export const Control = () => <div />;',
  }).join(), /不能依赖视图/);
  assert.deepEqual(checkArchitecture({
    "src/features/demo/useDemoController.ts": 'import { request } from "./requests.js";',
    "src/features/demo/requests.ts": 'export const request = () => 1;',
    "src/features/demo/types.ts": 'import type View = require("./DemoView");',
  }), []);
  assert.doesNotThrow(() => checkArchitecture({ "src/features/demo/state.ts": "require();" }));
});

test("查环穿过根目录转导出并报告分量，不误报纯类型或共享依赖", () => {
  const sources = {
    "src/compat.ts": 'export { value } from "./features/demo/index.js";',
    "src/features/demo/index.ts": 'export { value } from "./state.js";',
    "src/features/demo/state.ts": 'import { value } from "../../compat";',
  };
  const errors = checkArchitecture(sources);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /compat\.ts.*index\.ts.*state\.ts.*循环依赖/);
  assert.deepEqual(checkArchitecture({
    ...sources,
    "src/features/demo/state.ts": 'import type { Value } from "../../compat";',
  }), []);
  assert.deepEqual(checkArchitecture({
    "src/features/demo/index.ts": 'export { a } from "./a"; export { b } from "./b";',
    "src/features/demo/a.ts": 'import { shared } from "../../shared";',
    "src/features/demo/b.ts": 'import { shared } from "../../shared";',
    "src/shared.ts": "export const shared = 1;",
  }), []);
});

test("多个相交环仍识别功能依赖，根目录独立历史环不扩大迁移范围", () => {
  const legacy = {
    "src/a.ts": 'import "./b";',
    "src/b.ts": 'import "./a";',
  };
  assert.deepEqual(checkArchitecture(legacy), []);
  const errors = checkArchitecture({
    ...legacy,
    "src/b.ts": 'import "./a"; import "./features/demo";',
    "src/features/demo/index.ts": 'import "../../a";',
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /循环依赖/);
  assert.match(checkArchitecture({ "src/features/demo/state.ts": 'import "./state";' }).join(), /循环依赖/);
});
