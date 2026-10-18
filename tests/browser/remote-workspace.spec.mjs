import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { test } from "@playwright/test";

test("手机工作区分层后保留草稿、提交、重连、设置与窄屏交互", async ({ page }) => {
  await mkdir(new URL("../../output/playwright/", import.meta.url), { recursive: true });
  const script = new URL("../remote-workspace-browser.playwright.js", import.meta.url);
  const run = runInThisContext(await readFile(script, "utf8"), { filename: fileURLToPath(script) });
  await page.goto("/codey/tests/remote-workspace-browser.html");
  await run(page);
});
