import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  for (const width of [1280, 360]) {
    test(`管理面板加载、失败和重试：${theme} / ${width}`, async ({ page }, testInfo) => {
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript(() => {
        const state = window.loadingBehavior = { paused: true, requests: [] };
        let bridge;
        Object.defineProperty(window, "__codexSessionDeleteBridge", {
          configurable: true,
          get: () => bridge,
          set: original => {
            bridge = async (path, args) => {
              if (state.paused && path.endsWith("/load_codey_config")) {
                await new Promise((resolve, reject) => state.requests.push({ resolve, reject }));
              }
              return original(path, args);
            };
          },
        });
      });
      await page.goto(`/codey/tests/ui-browser.html?platform=windows&theme=${theme}`);
      const card = page.locator(".loading-card");
      await expect(card.getByRole("status")).toContainText("正在载入 CodeyX", { timeout: 60_000 });
      await expect(card.getByRole("status")).toContainText("正在连接 CodeyX");
      await expect(card.locator(".loading-animate-spin")).toHaveCSS("animation-name", "none");
      const shell = await page.locator(".loading-shell").boundingBox();
      const bounds = await card.boundingBox();
      expect(Math.abs(bounds.x + bounds.width / 2 - shell.x - shell.width / 2)).toBeLessThan(2);
      expect(Math.abs(bounds.y + bounds.height / 2 - shell.y - shell.height / 2)).toBeLessThan(2);
      await page.screenshot({ path: testInfo.outputPath("loading.png") });

      await expect.poll(() => page.evaluate(() => window.loadingBehavior.requests.length)).toBeGreaterThan(0);
      await page.evaluate(() => {
        window.loadingBehavior.paused = false;
        for (const request of window.loadingBehavior.requests) {
          request.reject(new Error(`测试：暂时无法读取配置。${"long-config-path/".repeat(24)}`));
        }
      });
      await expect(card.getByRole("status")).toContainText("CodeyX 加载失败");
      await expect(card.locator(".loading-animate-spin")).toHaveCount(0);
      await expect(card.getByRole("button", { name: "修复 Codex 配置", exact: true })).toBeEnabled();
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("failed.png") });
      await card.getByRole("button", { name: "重新检查", exact: true }).click();
      await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
      await expect(card).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
}
