async (page) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:1421/codey/tests/ui-browser.html?platform=windows");
  await page.getByRole("button", { name: "内置工具", exact: true }).click();
  const region = page.getByRole("region", { name: "内置工具", exact: true }).first();
  await region.getByRole("button", { name: "刷新", exact: true }).waitFor();
  if (await region.getByRole("textbox").count()) throw new Error("自动接入不应要求填写项目路径");
  const toggle = region.getByRole("switch", { name: "启用 CodeGraph 自动索引" });
  await toggle.locator("xpath=ancestor::label").click();
  await region.getByRole("status").filter({ hasText: "正在准备 CodeGraph 自动接入" }).waitFor();
  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "内置工具", exact: true }).click();
  await region.getByText("等待项目聊天，索引将自动开始。", { exact: true }).waitFor();
  await toggle.focus();
  await toggle.press("Space");
  await region.getByText("CodeyX 管理的 MCP · 已停用", { exact: true }).waitFor();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, theme);
    await page.waitForFunction(theme => {
      const root = document.querySelector("#codey-settings-overlay-host").shadowRoot.querySelector("#codey-overlay-modal-container");
      return root.dataset.theme === theme && root.getAnimations({ subtree: true }).every(animation => animation.playState !== "running");
    }, theme);
    await page.screenshot({ path: `output/playwright/builtin-tools-${theme}.png` });
  }
  await page.setViewportSize({ width: 420, height: 900 });
  await page.screenshot({ path: "output/playwright/builtin-tools-narrow.png" });
  const overflow = await region.evaluate(element => element.scrollWidth > element.clientWidth + 1);
  if (overflow) throw new Error("内置工具页面出现横向溢出");
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    window.__codexSessionDeleteBridge = async (path, args) => {
      const result = await bridge(path, args);
      if (path.endsWith("/builtin_tools") && args.action === "status") {
        result.projects = [{ projectPath: "E:/projects/" + "long-directory/".repeat(12), phase: "watching", message: "项目索引已接入，代码变化会自动同步。", updatedAt: Date.now() }];
      }
      return result;
    };
  });
  await region.getByRole("button", { name: "刷新", exact: true }).click();
  await region.getByText("项目索引已接入，代码变化会自动同步。", { exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/builtin-tools-long-path.png" });
  if (await region.evaluate(element => element.scrollWidth > element.clientWidth + 1)) throw new Error("长路径导致横向溢出");
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    let failStatus = true;
    window.__codexSessionDeleteBridge = (path, args) => {
      if (path.endsWith("/builtin_tools") && args.action === "status" && failStatus) {
        failStatus = false;
        return Promise.reject(new Error("测试：暂时无法读取配置"));
      }
      return bridge(path, args);
    };
  });
  await region.getByRole("button", { name: "刷新", exact: true }).click();
  await region.getByRole("alert").filter({ hasText: "暂时无法读取配置" }).waitFor();
  await region.getByRole("button", { name: "刷新", exact: true }).click();
  await region.getByRole("alert").waitFor({ state: "hidden" });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("PASS: 无路径启用、后台安装、切换栏目保留状态、键盘停用、明暗主题、窄屏、自动项目长路径与读取失败后重试。");
}
