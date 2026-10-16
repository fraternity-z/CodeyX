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
