import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../public/conversation-stats-inject.js", import.meta.url));

for (const theme of ["light", "dark"]) {
  test(`会话状态条 ${theme} 主题可打开详情、键盘关闭并适应窄屏`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<html class="${theme}" style="color-scheme:${theme}"><body style="margin:24px;font-family:system-ui;background:${theme === "dark" ? "#181818" : "#fff"}"><main style="max-width:720px;margin:320px auto 0"><div data-above-composer-conversation-id="11111111-1111-4111-8111-111111111111"></div><textarea aria-label="消息" style="box-sizing:border-box;width:100%;height:100px;border-radius:16px;padding:16px">继续完善当前功能</textarea></main></body></html>`);
    await page.evaluate(() => {
      window.__codexSessionDeleteBridge = async () => ({ status: "ok", stats: {
        usageSource: "rollout", usageScope: "session", turnCount: 8,
        totalTokens: 125000, inputTokens: 100000, outputTokens: 25000, cachedInputTokens: 75000,
        lastTurn: { id: "turn-a", status: "completed", stepCount: 3,
          modelDurationMs: 24500, toolDurationMs: 8000, averageTtftMs: 700,
          averageOutputTokensPerSecond: 85, coverage: "runtime", speedIsEstimate: false },
      }, codegraph: { projectPath: "E:/projects/current-project", phase: "watching", message: "项目索引已接入，代码变化会自动同步。" } });
    });
    await page.addScriptTag({ path: script });
    const bar = page.locator("#codey-conversation-stats");
    await expect(bar).toContainText("8 轮 · 3 步");
    await expect(bar).toContainText("125k tok");
    await expect(bar).toContainText("75%");
    await expect(bar).toContainText("CodeGraph 已接入");
    const activity = bar.locator(".codey-cs-activity-summary");
    await activity.focus();
    await activity.press("Enter");
    const detail = page.getByRole("region", { name: "最近一轮统计", exact: true });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("24.5秒");
    await page.screenshot({ path: `output/playwright/conversation-stats-${theme}.png` });
    await page.keyboard.press("Escape");
    await expect(detail).not.toBeVisible();
    await expect(activity).toBeFocused();
    await page.setViewportSize({ width: 375, height: 667 });
    await bar.locator(".codey-cs-tokens-summary").click();
    const tokens = page.getByRole("region", { name: "Token 用量", exact: true });
    await expect(tokens).toBeVisible();
    const box = await tokens.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    await expect(tokens.locator('[data-field="uncachedInputTokens"]')).toHaveText("25,000 tok");
    await page.screenshot({ path: `output/playwright/conversation-stats-${theme}-narrow.png` });
    const codegraph = bar.locator(".codey-cs-codegraph-summary");
    await codegraph.focus();
    await codegraph.press("Enter");
    const project = page.getByRole("region", { name: "CodeGraph 代码索引", exact: true });
    await expect(project).toBeVisible();
    await expect(project).toContainText("E:/projects/current-project");
    await expect(project).toContainText("代码变化会自动同步");
    const projectBox = await project.boundingBox();
    expect(projectBox.x).toBeGreaterThanOrEqual(0);
    expect(projectBox.x + projectBox.width).toBeLessThanOrEqual(375);
    await page.screenshot({ path: `output/playwright/conversation-codegraph-${theme}-narrow.png` });
    await page.keyboard.press("Escape");
    await expect(project).not.toBeVisible();
    await expect(codegraph).toBeFocused();
    await page.evaluate(() => window.__codeyConversationStats.dispose());
    await expect(bar).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
