import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";
import { featurePolicyRuntimeFixture } from "./helpers/feature-policy.mjs";

const { featurePolicyStatus, confirmedDiskProtections } = await loadTypeScriptModule(
  new URL("../src/features/feature-policy/state.ts", import.meta.url),
);
const policyKeys = ["gpuLaunchMode", "slimCodexPet", "disableTraceLogWrites", "protectCrashpadPending", "hideFullAccessWarning"];
const phase = (key, runtime, draft = runtime.featurePolicy?.configured ?? {}) => featurePolicyStatus(key, draft, runtime).phase;

test("known running policies require their own application and verification evidence", () => {
  const runtime = featurePolicyRuntimeFixture();
  assert.deepEqual(policyKeys.map(key => phase(key, runtime)), ["disabled", "verified", "verified", "verified", "disabled"]);
  runtime.featurePolicy.configured.gpuLaunchMode = runtime.featurePolicy.applied.gpuLaunchMode = "disableGpu";
  assert.equal(phase("gpuLaunchMode", runtime), "applied");
  assert.deepEqual(confirmedDiskProtections(runtime), { trace: true, crashpad: true });
});

test("unsaved switches preserve the current instance result", () => {
  const runtime = featurePolicyRuntimeFixture();
  const draft = { ...runtime.featurePolicy.configured, slimCodexPet: false };
  const current = featurePolicyStatus("slimCodexPet", draft, runtime);
  assert.equal(current.unsaved, true);
  assert.equal(current.phase, "verified");
  assert.equal(featurePolicyStatus("disableTraceLogWrites", draft, runtime).unsaved, false);
});

test("saved launch policy changes wait for restart and clear after the new baseline arrives", () => {
  const runtime = featurePolicyRuntimeFixture();
  runtime.featurePolicy.configured.gpuLaunchMode = "disableGpuRasterization";
  runtime.featurePolicy.configured.slimCodexPet = false;
  assert.equal(phase("gpuLaunchMode", runtime), "restart_required");
  assert.equal(phase("slimCodexPet", runtime), "restart_required");
  runtime.featurePolicy.applied.gpuLaunchMode = "disableGpuRasterization";
  runtime.featurePolicy.applied.slimCodexPet = false;
  runtime.injectionScripts[0].status = "inactive";
  assert.equal(phase("gpuLaunchMode", runtime), "applied");
  assert.equal(phase("slimCodexPet", runtime), "disabled");
});

test("application in progress and failure remain distinct from saved configuration", () => {
  const runtime = featurePolicyRuntimeFixture();
  runtime.featurePolicy.configured.gpuLaunchMode = "disableGpu";
  runtime.configApply = { phase: "pending" };
  const pending = featurePolicyStatus("gpuLaunchMode", runtime.featurePolicy.configured, runtime);
  assert.equal(pending.phase, "applying");
  assert.match(pending.detail, /当前实例：待重启/);
  runtime.configApply = { phase: "failed", applyError: "测试：应用失败" };
  assert.equal(phase("gpuLaunchMode", runtime), "failed");
  assert.match(featurePolicyStatus("gpuLaunchMode", runtime.featurePolicy.configured, runtime).detail, /测试：应用失败/);
});

test("stopped and older runtimes never count configured protection as verified", () => {
  const runtime = featurePolicyRuntimeFixture();
  runtime.running = false;
  assert.deepEqual(policyKeys.map(key => phase(key, runtime)), policyKeys.map(() => "stopped"));
  assert.deepEqual(confirmedDiskProtections(runtime), { trace: false, crashpad: false });
  runtime.running = true;
  delete runtime.featurePolicy;
  assert.deepEqual(policyKeys.map(key => phase(key, runtime)), policyKeys.map(() => "pending"));
  assert.deepEqual(confirmedDiskProtections(runtime), { trace: false, crashpad: false });
});

test("pet entry control alone cannot verify automatic prewarm suppression", () => {
  const runtime = featurePolicyRuntimeFixture();
  runtime.injectionScripts[1].detail = "已抑制：CPU 采样";
  assert.equal(phase("slimCodexPet", runtime), "partial");
  runtime.injectionScripts[0] = { id: "pet-control-shield", status: "failed", error: "测试：控件探测失败" };
  assert.equal(phase("slimCodexPet", runtime), "failed");
});

test("security warning policy needs a matching active or inactive probe", () => {
  const runtime = featurePolicyRuntimeFixture();
  runtime.featurePolicy.configured.hideFullAccessWarning = true;
  assert.equal(phase("hideFullAccessWarning", runtime), "pending");
  runtime.injectionScripts[2].status = "effective";
  assert.equal(phase("hideFullAccessWarning", runtime), "verified");
  runtime.injectionScripts[2].status = "executed";
  assert.equal(phase("hideFullAccessWarning", runtime), "pending");
});

test("trace discovery waits for log tables and reports watcher failures", () => {
  const runtime = featurePolicyRuntimeFixture();
  runtime.featurePolicy.traceProtection.logTablesFound = 0;
  assert.equal(phase("disableTraceLogWrites", runtime), "pending");
  runtime.featurePolicy.traceProtection.logTablesFound = 1;
  runtime.featurePolicy.traceProtection.pending = true;
  assert.equal(phase("disableTraceLogWrites", runtime), "applying");
  runtime.featurePolicy.traceWatcherActive = false;
  assert.equal(phase("disableTraceLogWrites", runtime), "failed");
});

for (const [key, snapshotKey] of [["disableTraceLogWrites", "traceProtection"], ["protectCrashpadPending", "crashpadProtection"]]) {
  test(`${key}: errors and recovery use the latest check, not an old successful timestamp`, () => {
    const runtime = featurePolicyRuntimeFixture();
    const snapshot = runtime.featurePolicy[snapshotKey];
    snapshot.capturedAt++;
    snapshot.errors = ["测试：诊断文件被占用"];
    assert.equal(phase(key, runtime), "degraded");
    snapshot.lastSuccessfulAt = null;
    assert.equal(phase(key, runtime), "failed");
    snapshot.errors = [];
    assert.equal(phase(key, runtime), "pending");
    snapshot.lastSuccessfulAt = snapshot.capturedAt;
    assert.equal(phase(key, runtime), "verified");
  });
}

test("an alive Crashpad watcher with excess reports is a partial failure", () => {
  const runtime = featurePolicyRuntimeFixture();
  runtime.featurePolicy.crashpadProtection.overLimit = true;
  assert.equal(phase("protectCrashpadPending", runtime), "degraded");
  assert.deepEqual(confirmedDiskProtections(runtime), { trace: true, crashpad: false });
  runtime.featurePolicy.crashpadProtection.overLimit = false;
  runtime.featurePolicy.crashpadProtection.lastSuccessfulAt = null;
  assert.equal(phase("protectCrashpadPending", runtime), "pending");
});

test("disabling disk protection requires confirmation from the running instance", () => {
  const runtime = featurePolicyRuntimeFixture();
  runtime.featurePolicy.configured.disableTraceLogWrites = false;
  runtime.featurePolicy.configured.protectCrashpadPending = false;
  assert.equal(phase("disableTraceLogWrites", runtime), "pending");
  assert.equal(phase("protectCrashpadPending", runtime), "pending");
  runtime.traceLogWriteProtectionActive = runtime.crashpadDiskProtectionActive = false;
  assert.equal(phase("disableTraceLogWrites", runtime), "disabled");
  assert.equal(phase("protectCrashpadPending", runtime), "disabled");
});

test("optimization summary excludes unverified and failed disk guards", () => {
  const { buildEnabledOptimizationFeatures } = createModuleGraph(new URL("../src/runtimeStatusPresentation.ts", import.meta.url)).exports;
  const runtime = featurePolicyRuntimeFixture();
  const fastctx = { userConfigured: false, detectionFailed: false };
  const disk = () => buildEnabledOptimizationFeatures(runtime, fastctx).find(item => item.id === "disk-write-protection");
  assert.match(disk().detail, /均已生效/);
  runtime.featurePolicy.crashpadProtection.errors = ["测试：清理失败"];
  assert.equal(disk().detail, "Codex Trace 日志写盘保护已生效");
  delete runtime.featurePolicy;
  assert.equal(disk(), undefined);
});
