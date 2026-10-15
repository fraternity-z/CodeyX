async page => {
  if (!page.url().includes("/codey/tests/ui-browser.html")) throw new Error("Open the update dialog fixture first");
  const fixture = page.url().split("?")[0];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://example.test/release-preview.png", route => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="220" viewBox="0 0 960 220"><rect width="960" height="220" rx="12" fill="#f2f4f7"/><rect x="32" y="32" width="180" height="156" rx="6" fill="#e0e5ec"/><rect x="244" y="40" width="440" height="20" rx="4" fill="#344054"/><rect x="244" y="86" width="650" height="10" rx="4" fill="#98a2b3"/><rect x="244" y="116" width="510" height="10" rx="4" fill="#98a2b3"/><rect x="244" y="154" width="100" height="30" rx="6" fill="#0066d6"/></svg>',
  }));
  const open = async (state, theme, viewport, shadow = false) => {
    await page.setViewportSize(viewport);
    await page.goto(`${fixture}?view=update&state=${state}&theme=${theme}&shadow=${shadow ? 1 : 0}`);
    await page.locator(".update-confirmation-dialog").waitFor();
    if (state !== "empty") await page.locator(".release-notes").waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const layout = async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById("root").shadowRoot || document;
      const rect = selector => root.querySelector(selector).getBoundingClientRect().toJSON();
      const notes = root.querySelector(".update-release-notes");
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, dialog: rect(".update-confirmation-dialog"), footer: rect(".update-confirmation-dialog [data-slot=modal-footer]"), notes: notes && { width: notes.clientWidth, scrollWidth: notes.scrollWidth, height: notes.clientHeight, scrollHeight: notes.scrollHeight } };
    });
    assert(result.documentWidth <= result.width, `Horizontal page overflow: ${JSON.stringify(result)}`);
    assert(result.dialog.left >= 0 && result.dialog.right <= result.width + 1 && result.dialog.top >= 0 && result.dialog.bottom <= result.height + 1, `Dialog outside viewport: ${JSON.stringify(result)}`);
    assert(result.footer.bottom <= result.height && result.footer.top >= 0, "Update actions are outside the viewport");
    if (result.notes) assert(result.notes.scrollWidth <= result.notes.width + 1, "Announcement content overflows horizontally");
    return result;
  };
  for (const [shadow, theme] of [[false, "light"], [false, "dark"], [true, "light"], [true, "dark"]]) {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }, { width: 900, height: 400 }]) {
      await open("markdown", theme, viewport, shadow);
      await page.waitForFunction(() => { const root = document.getElementById("root").shadowRoot || document; const image = root.querySelector(".release-notes img"); return image?.complete && image.naturalWidth > 0; });
      await layout();
      assert(await page.locator(".release-notes table").count() === 1, "GFM table is missing");
      assert(await page.locator(".release-notes .hljs-keyword, .release-notes .hljs-attr").count() > 0, "Code highlighting is missing");
      assert(await page.locator(".release-notes [data-release-alert=important]").count() === 1, "GitHub alert is missing");
      const source = page.getByRole("link", { name: "在 GitHub 查看" });
      assert(await source.getAttribute("target") === "_blank", "Release link navigates the host window");
      assert(await source.getAttribute("rel") === "noopener noreferrer", "Release link does not isolate its opener");
      await page.locator(".release-notes summary").click();
      assert(await page.locator(".release-notes details").getAttribute("open") !== null, "Details cannot be expanded");
      await page.getByRole("link", { name: "跳至升级须知" }).click();
      assert(await page.locator(".update-release-notes").evaluate(element => element.scrollTop > 0), "Heading link did not scroll the announcement");
      assert(!page.url().includes("#"), "Heading link changed the host route");
      await page.keyboard.press("Escape");
      assert(await page.evaluate(() => window.updateFixture.dismissed), "Escape did not dismiss the dialog");
    }
  }
  for (const state of ["long", "grouped", "empty"]) {
    await open(state, "light", { width: 390, height: 700 });
    const result = await layout();
    if (state === "long") assert(result.notes.scrollHeight > result.notes.height, "Long release notes do not scroll");
    if (state === "empty") assert(await page.locator(".update-announcement").count() === 0, "Empty notes leave an empty announcement panel");
    await page.getByRole("button", { name: "立即更新" }).click();
    assert(await page.evaluate(() => window.updateFixture.confirmed), "The update action is not usable");
  }
  await open("markdown", "light", { width: 1280, height: 900 });
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  return { scenarios: 19, themes: ["light", "dark"], contexts: ["document", "Shadow DOM"], assertions: "Markdown, images, links, anchors, details, scrolling, keyboard dismissal, responsive actions" };
}
