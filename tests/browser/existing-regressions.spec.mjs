import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { test } from "@playwright/test";

// Keep the existing Playwright CLI scripts usable manually and in CI.
for (const [name, filename, fixture] of [
  ["更新公告的主题、Shadow DOM、窄屏和键盘交互", "release-notes-browser.playwright.js", "?view=update&state=markdown"],
  ["内置工具启停、页面切换和读取失败后重试", "builtin-tools-browser.playwright.js", "?platform=windows"],
]) {
  test(name, async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    await mkdir(new URL("../../output/playwright/", import.meta.url), { recursive: true });
    const scriptURL = new URL(`../${filename}`, import.meta.url);
    const run = runInThisContext(await readFile(scriptURL, "utf8"), {
      filename: fileURLToPath(scriptURL),
    });
    await page.goto(`/codey/tests/ui-browser.html${fixture}`);
    await run(page, { baseURL });
  });
}
