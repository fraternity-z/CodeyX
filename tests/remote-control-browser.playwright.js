async (page, { baseURL = "http://127.0.0.1:1421" } = {}) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${baseURL}/codey/tests/remote-control-browser.html?state=stopped`);
  await page.getByRole("button", { name: "远程控制", exact: true }).click();
  const region = page.getByRole("region", { name: "远程控制", exact: true });
  await region.getByRole("button", { name: "开启远程控制", exact: true }).waitFor();
  await region.getByText("网络设置", { exact: true }).click();
  await region.getByLabel("端口", { exact: true }).fill("43210");
  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "远程控制", exact: true }).click();
  if (await region.getByLabel("端口", { exact: true }).inputValue() !== "43210") throw new Error("切换栏目丢失网络草稿");

  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    window.remoteBehavior = { starts: 0 };
    window.__codexSessionDeleteBridge = async (path, args) => {
      if (path.endsWith("/start_remote_control")) {
        window.remoteBehavior.starts++;
        await new Promise(resolve => { window.remoteBehavior.releaseStart = resolve; });
      }
      if (path.endsWith("/pair_remote_control")) return {
        url: `${args.url}/#pair=fixture`, qrCode: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", expiresIn: 600,
      };
      return bridge(path, args);
    };
  });
  await region.getByRole("button", { name: "开启远程控制", exact: true }).click();
  await page.waitForFunction(() => typeof window.remoteBehavior.releaseStart === "function");
  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "远程控制", exact: true }).click();
  if (!await region.getByRole("button", { name: "开启远程控制", exact: true }).isDisabled()) throw new Error("隐藏重开提前释放了写入锁");
  await page.evaluate(() => window.remoteBehavior.releaseStart());
  await region.getByRole("button", { name: "关闭远程控制", exact: true }).waitFor();
  if (await page.evaluate(() => window.remoteBehavior.starts) !== 1) throw new Error("重放了开启命令");

  await region.getByRole("button", { name: "生成一次性配对码", exact: true }).click();
  await region.getByRole("img", { name: "手机远程配对二维码" }).waitFor();
  await region.getByRole("combobox", { name: "连接地址", exact: true }).selectOption("http://192.168.1.8:43129");
  await region.getByRole("img", { name: "手机远程配对二维码" }).waitFor({ state: "hidden" });
  await region.getByRole("button", { name: "关闭远程控制", exact: true }).click();
  await region.getByRole("button", { name: "开启远程控制", exact: true }).waitFor();
  if (!await region.getByRole("button", { name: "生成一次性配对码", exact: true }).isDisabled()) throw new Error("服务关闭后仍可配对");
  await region.getByLabel("端口", { exact: true }).fill("0");
  await region.getByRole("button", { name: "开启远程控制", exact: true }).click();
  await region.getByRole("alert").filter({ hasText: "1–65535" }).waitFor();
  if (await page.evaluate(() => window.remoteBehavior.starts) !== 1) throw new Error("无效端口仍发送了写入");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("PASS: 远程控制草稿保留、写入期间隐藏重开、防重放、配对地址切换、关闭与校验提示。");
}
