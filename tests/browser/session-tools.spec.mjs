import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const sources = ["codex-runtime-adapter.js", "codey-inject.js"].map(name => (
  readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8")
));

test("会话工具保留整段会话操作，不再为对话轮次添加选择和删除控件", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(`
    <aside data-app-action-sidebar-section>
      <div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:fixture"
           data-app-action-sidebar-thread-title="会话测试">
        会话测试<button aria-label="Archive">归档</button>
      </div>
    </aside>
    <main id="conversation" data-session-id="fixture">
      <section data-turn-key="turn-1">第一轮</section>
      <section data-turn-key="turn-2" hidden>第二轮</section>
    </main>
  `);
  await page.evaluate(() => {
    window.fixture = { calls: [], deletes: 0 };
    window.__codexSessionDeleteBridge = async (path, payload) => {
      window.fixture.calls.push({ path, payload });
      return { status: "ok", timestamps: {} };
    };
    window.__codeyCodexSessionController = {
      kind: "manager",
      async reconcileCompletedConversation() { return false; },
    };
    document.querySelector("[data-app-action-sidebar-thread-row]").__reactFiber$fixture = {
      memoizedProps: {
        getItems: () => [{ id: "delete-thread", onSelect: () => { window.fixture.deletes += 1; } }],
      },
    };
  });
  for (const content of sources) await page.addScriptTag({ content });
  await expect(page.getByRole("button", { name: "导出会话数据", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "永久删除", exact: true })).toBeVisible();
  const removedControls = page.locator("#codey-message-toolbar, [data-codey-message-select], [data-codey-message-id]");
  await expect(removedControls).toHaveCount(0);

  await page.evaluate(() => {
    document.querySelector('[data-turn-key="turn-2"]').hidden = false;
    const turn = document.createElement("section");
    turn.dataset.turnKey = "turn-3";
    turn.textContent = "第三轮";
    document.querySelector("#conversation").appendChild(turn);
    document.querySelector("[data-app-action-sidebar-thread-row]")
      .setAttribute("data-app-action-sidebar-thread-title", "会话更新");
  });
  await expect.poll(() => page.evaluate(() => window.fixture.calls.some(call => (
    call.path === "/session/titles" && call.payload.titles.some(title => title.title === "会话更新")
  )))).toBe(true);
  await expect(removedControls).toHaveCount(0);
  await expect(page.locator("#conversation section")).toHaveText(["第一轮", "第二轮", "第三轮"]);
  await page.getByRole("button", { name: "永久删除", exact: true }).click();
  expect(await page.evaluate(() => window.fixture.deletes)).toBe(1);
  expect(await page.evaluate(() => window.fixture.calls.some(call => call.path === "/session/delete-messages"))).toBe(false);
  expect(errors).toEqual([]);
});
