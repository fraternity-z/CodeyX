import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const root = new URL("../", import.meta.url);

test("settings panels declare render-isolation hooks and stable handlers", async () => {
  const [
    app,
    appUpdates,
    updateRequests,
    notice,
    confirmation,
    sections,
    modelSelection,
    draftConfig,
    routes,
  ] = await Promise.all([
    readFile(new URL("src/App.tsx", root), "utf8"),
    readFile(new URL("src/features/app-updates/useAppUpdatesController.ts", root), "utf8"),
    readFile(new URL("src/features/app-updates/requests.ts", root), "utf8"),
    readFile(new URL("src/useAppNotice.tsx", root), "utf8"),
    readFile(new URL("src/useConfirmationDialog.tsx", root), "utf8"),
    Promise.all(
      [
        "OperationsPanel.tsx",
        "ModelSection.tsx",
        "FeaturePolicyCard.tsx",
        "features/subagents/SubagentPolicyCard.tsx",
      ].map((file) => readFile(new URL(`src/${file}`, root), "utf8")),
    ).then((sources) => sources.join("\n")),
    readFile(new URL("src/features/model-selection/useModelSelectionController.ts", root), "utf8"),
    readFile(new URL("src/useDraftConfig.ts", root), "utf8"),
    readFile(new URL("src/features/routes/useRoutesController.ts", root), "utf8"),
  ]);

  assert.doesNotMatch(app, /useState<Notice>/);
  assert.doesNotMatch(app, /useState<Confirmation/);
  assert.match(notice, /useSyncExternalStore\(/);
  assert.match(notice, /export const NoticeToast = memo\(/);
  assert.match(confirmation, /useSyncExternalStore\(/);
  assert.match(confirmation, /export const ConfirmationDialogHost = memo\(/);
  assert.doesNotMatch(app, /async function checkForUpdates\(/);
  assert.match(appUpdates, /export function useAppUpdates/);
  assert.match(updateRequests, /invoke<UpdateCheck>\("check_for_updates",\s*\{\s*forceRefresh/);
  assert.equal(
    updateRequests.match(/invoke<UpdateCheck>\("check_for_updates",/g)?.length,
    1,
  );
  assert.match(
    appUpdates,
    /updateCheckInFlightRef = useRef<Promise<UpdateCheck> \| null>/,
  );
  assert.match(appUpdates, /const result = await requestUpdateCheck\(\)/);
  assert.match(appUpdates, /const result = await requestUpdateCheck\(true/);
  assert.match(
    app,
    /const handleFooterUpdateClick = useStableEvent\(\(\) => void checkForUpdates\(\)\)/,
  );
  assert.match(updateRequests, /invoke<UpdateDownload>\(\s*"download_update",/);
  assert.match(updateRequests, /invoke<void>\("install_downloaded_update"/);
  assert.doesNotMatch(appUpdates, /\binvoke\b/);
  assert.match(app, /onRepairPluginMarketplace=\{handleRepairPluginMarketplace\}/);
  assert.match(app, /onAnalyzeDiagnosticStorage=\{handleAnalyzeDiagnosticStorage\}/);
  assert.match(app, /onToggleDraftModel=\{toggleDraftModel\}/);
  assert.match(app, /onSaveRoute=\{handleSaveRoute\}/);
  assert.doesNotMatch(app, /activeProfileId:\s*route\.id/);
  assert.match(app, /onDeleteRoute=\{handleDeleteRoute\}/);
  assert.match(app, /onFetchRouteModels=\{handleFetchRouteModels\}/);
  assert.match(app, /onSetDefaultModel=\{handleSetRouteDefaultModel\}/);
  assert.match(app, /onToggleLocalRouter=\{handleToggleLocalRouter\}/);
  assert.match(app, /onToggleRouteRequestLog=\{handleToggleRouteRequestLog\}/);
  assert.match(
    app,
    /onOfficialAccountsChanged=\{handleOfficialAccountsChanged\}/,
  );
  assert.match(app, /onSave=\{saveModelSelection\}/);
  assert.doesNotMatch(modelSelection, /withTimeout/);
  assert.match(modelSelection, /routeId: modelPickerRouteId/);
  assert.match(routes, /routeModelState/);
  assert.doesNotMatch(app, /onSetDefaultModel=\{\(.*=>/);
  assert.doesNotMatch(
    app,
    /onRepairPluginMarketplace=\{\(\) => void repairPluginMarketplace\(\)\}/,
  );
  assert.match(sections, /aria-labelledby="route-protocol-label"/);
  assert.match(sections, /OpenAI Responses/);
  assert.match(sections, /OpenAI Chat Completions/);
  assert.match(sections, /Anthropic Messages/);
  assert.doesNotMatch(sections, /route-auth-mode-label/);
  assert.equal(sections.match(/<Select\s/g)?.length, 4);
  assert.equal(sections.match(/<ModelCombobox\s/g)?.length, 3);
  assert.doesNotMatch(sections, /<select/);
  assert.match(sections, /visibleProfiles\.map\(\(profile\) =>/);
  assert.doesNotMatch(sections, /route-list-pane|route-manager-balanced|<Listy/);
  assert.match(sections, /route-manager-current/);
  assert.match(sections, /className="provider-model-groups"/);
  assert.match(sections, /useRouteCatalogController\(/);
  assert.match(sections, /checked=\{config\.localRouterEnabled\}/);
  assert.match(sections, /const routeConfigReadOnly = !config\.localRouterEnabled/);
  assert.match(sections, /checked=\{checked\}/);
  assert.match(sections, /<OfficialAccountsPanel\s/);
  assert.doesNotMatch(sections, /isOfficial && [^\n]*<OfficialAccountsPanel/);
  assert.doesNotMatch(sections, /provider-model-usage-toggle/);
  assert.match(sections, /<DialogTitle>/);
  assert.match(sections, /config\.localRouterEnabled && \(/);
  assert.match(sections, /checked=\{config\.routeRequestLog\.enabled\}/);
  assert.match(sections, /onCheckedChange=\{onToggleRouteRequestLog\}/);
  assert.match(sections, /查看请求日志/);
  assert.match(sections, /当前线路模型/);
  assert.match(sections, /仅展示 Codex 当前线路，可同步模型/);
  // 原生模式目录与模型筛选由 route-catalog.test.mjs 验证，视图仅消费结果。
  assert.doesNotMatch(sections, /const nativeProfile = useMemo/);
  assert.match(sections, /disabled=\{!canSyncCurrentProvider \|\| isBusy\}/);
  assert.match(draftConfig, /canSyncCurrentProvider: !dirty \|\| pendingNativeRouterToggle/);
  assert.match(app, /canSyncCurrentProvider=\{canSyncCurrentProvider\}/);
  assert.match(routes, /if \(shouldPersistNativeToggle\) await persist\(config\)/);
  assert.match(routes, /if \(nativeMode\) completeModelPickerLoad\(/);
  assert.match(routes, /result\.providerStatus\.provider\.official \? null : result\.providerStatus\.provider\.id/);
  assert.match(routes, /if \(!config\.localRouterEnabled\) \{ await syncCurrentProvider\(\); return/);
  assert.match(routes, /savedRoute\.authMode === "officialAccount"\s*\?\s*result\.routeModelState/);
  assert.match(
    sections,
    /disabled=\{\s*routeConfigReadOnly \|\|\s*(?:isOfficial \|\|\s*)?isBusy \|\|\s*dirty \|\|\s*config\.profiles\.length <= 1\s*\}/,
  );
  assert.match(sections, /供应商与模型/);
  assert.doesNotMatch(sections, /catalog-search|searchQuery|搜索模型\.\.\./);
  assert.match(sections, /点击模型设为全局默认/);
  assert.match(sections, /待配置模型/);
  assert.doesNotMatch(sections, /aria-pressed|route-list-select/);
  assert.doesNotMatch(sections, /role="radiogroup"/);

  for (const component of [
    "OperationsPanel",
    "ModelSection",
    "FeaturePolicyCard",
    "SubagentPolicyCard",
  ]) {
    assert.match(sections, new RegExp(`export const ${component} = memo\\(`));
  }
});

test("runtime polling preserves referentially stable status slices", async () => {
  const { reconcileRuntimeStatus } = await loadTypeScriptModule(
    new URL("../src/features/runtime-status/state.ts", import.meta.url),
  );
  const current = {
    running: false,
    appVersion: "1.0.0",
    maintenance: { sessionStatus: "ready", sessionFilesFixed: 2 },
    injectionScripts: [{ id: "bridge", status: "effective" }],
  };

  const equalSnapshot = structuredClone(current);
  assert.equal(reconcileRuntimeStatus(current, equalSnapshot), current);

  const changedRoot = reconcileRuntimeStatus(current, {
    ...structuredClone(current),
    running: true,
  });
  assert.notEqual(changedRoot, current);
  assert.equal(changedRoot.maintenance, current.maintenance);
  assert.equal(changedRoot.injectionScripts, current.injectionScripts);

  const changedMaintenance = reconcileRuntimeStatus(current, {
    ...structuredClone(current),
    maintenance: { sessionStatus: "error", sessionFilesFixed: 2 },
  });
  assert.notEqual(changedMaintenance.maintenance, current.maintenance);
});
