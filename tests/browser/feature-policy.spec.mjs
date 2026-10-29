import { expect, test as base } from "@playwright/test";
import { featurePolicyRuntimeFixture } from "../helpers/feature-policy.mjs";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "功能策略状态不应出现未捕获异常").toEqual([]);
  },
});

async function installRuntime(page, runtime = featurePolicyRuntimeFixture()) {
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(runtime => {
    const bridge = window.__codexSessionDeleteBridge;
    window.featurePolicyBehavior = { runtime };
    window.__codexSessionDeleteBridge = async (path, args) => {
      const result = await bridge(path, args);
      const fixture = window.featurePolicyBehavior.runtime;
      if (path.endsWith("/save_codey_config") && result.config && fixture.featurePolicy) {
        for (const key of Object.keys(fixture.featurePolicy.configured)) fixture.featurePolicy.configured[key] = result.config[key];
      }
      return path.endsWith("/runtime_status") ? structuredClone({ ...result, ...fixture, appVersion: "9.0.7" }) : result;
    };
    window.dispatchEvent(new Event("codey-injection-status-changed"));
  }, runtime);
  await expect(page.getByText("v9.0.7", { exact: true })).toBeVisible();
}

const policy = (page, key) => page.locator(`[data-policy-status="${key}"]`);
const policyCard = (page, key) => page.locator(".feature-card").filter({ has: policy(page, key) });

for (const theme of ["light", "dark"]) {
  for (const width of [1280, 360]) {
    test(`功能策略状态与检查摘要：${theme} / ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/codey/tests/ui-browser.html?platform=windows&theme=${theme}&injection=cli`);
      await installRuntime(page);
      await expect(policy(page, "gpuLaunchMode")).toContainText("已关闭");
      for (const key of ["slimCodexPet", "disableTraceLogWrites", "protectCrashpadPending"]) {
        await expect(policy(page, key)).toContainText("已验证");
      }
      await expect(policy(page, "disableTraceLogWrites")).toContainText("日志表 1 / 数据库 1");
      await expect(policy(page, "protectCrashpadPending")).toContainText("占用 128 MB / 上限 512 MB");
      await expect(policy(page, "protectCrashpadPending")).toContainText("最近成功：");
      const notice = page.locator('[data-main-injection-status="degraded"]');
      await expect(notice).toContainText("主进程补丁尚未确认");
      await expect(notice).not.toContainText("Codex 启动成功");
      for (const key of ["gpuLaunchMode", "slimCodexPet", "disableTraceLogWrites", "protectCrashpadPending", "hideFullAccessWarning"]) {
        await policyCard(page, key).screenshot({ path: `output/playwright/feature-policy/after-${theme}-${width}-${key}.png` });
      }
      await page.screenshot({ path: testInfo.outputPath("feature-policy.png"), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      const petSwitch = page.getByRole("switch", { name: "精简 Codex 宠物模块", exact: true });
      await petSwitch.focus();
      await petSwitch.press("Space");
      await expect(policy(page, "slimCodexPet")).toContainText("未保存");
      await expect(policy(page, "slimCodexPet")).toContainText("已验证");
      await expect(policy(page, "slimCodexPet")).toContainText("以下为当前实例状态");
      await page.getByRole("button", { name: "保存更改", exact: true }).click();
      await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
      await expect(policy(page, "slimCodexPet")).toContainText("待重启");
      await expect(policy(page, "slimCodexPet")).not.toContainText("未保存");
    });
  }
}

test("清理失败与超限显式展示，成功检查后自动刷新验证状态", async ({ page }, testInfo) => {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  const runtime = featurePolicyRuntimeFixture();
  runtime.featurePolicy.traceProtection.errors = ["测试：日志库暂时被占用，请稍后重试"];
  runtime.featurePolicy.crashpadProtection.overLimit = true;
  runtime.featurePolicy.crashpadProtection.pendingBytes = 600 * 1024 * 1024;
  await installRuntime(page, runtime);
  await expect(policy(page, "disableTraceLogWrites")).toContainText("部分失败");
  await expect(policy(page, "disableTraceLogWrites")).toContainText("测试：日志库暂时被占用");
  await expect(policy(page, "protectCrashpadPending")).toContainText("仍超过安全上限");
  await policyCard(page, "disableTraceLogWrites").screenshot({ path: testInfo.outputPath("trace-failure.png") });
  await policyCard(page, "protectCrashpadPending").screenshot({ path: testInfo.outputPath("crashpad-failure.png") });
  await page.evaluate(() => {
    const policy = window.featurePolicyBehavior.runtime.featurePolicy;
    policy.traceProtection.errors = [];
    policy.crashpadProtection.overLimit = false;
    policy.crashpadProtection.pendingBytes = 384 * 1024 * 1024;
  });
  await expect(policy(page, "disableTraceLogWrites")).toContainText("已验证", { timeout: 35_000 });
  await expect(policy(page, "protectCrashpadPending")).toContainText("已验证");
});

test("旧后端的启用标记不能冒充策略检查成功", async ({ page }) => {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await installRuntime(page, { running: true, traceLogWriteProtectionActive: true, crashpadDiskProtectionActive: true });
  await expect(policy(page, "disableTraceLogWrites")).toContainText("待验证");
  await expect(policy(page, "protectCrashpadPending")).toContainText("待验证");
  await expect(policy(page, "disableTraceLogWrites")).not.toContainText("已验证");
});
