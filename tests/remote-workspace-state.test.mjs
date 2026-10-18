import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const { restoreWorkspaceDraft, canSendDraft, firstTurnDraft, conversationEvent } = await loadTypeScriptModule(new URL("../src/features/remote-workspace/state.ts", import.meta.url));
const image = { name: "fixture.png", url: "data:image/png;base64,YQ==", size: 1 };
const draft = { text: "任务", images: [image], uncertain: false, settings: { serviceTier: null } };

test("恢复草稿保留空文本、图片占位及显式 null，未确认记录阻止再次发送", () => {
  const pending = { id: "fixture", args: { text: "pending", images: [image, { ...image, url: "" }, null, { name: "bad" }], model: "model", effort: "high", permissionMode: "auto", serviceTier: null } };
  const restored = restoreWorkspaceDraft(undefined, pending);
  assert.equal(restored.uncertain, true);
  assert.deepEqual(restored.images, [image, { ...image, url: "" }]);
  assert.deepEqual(restored.settings, { model: "model", effort: "high", permissionMode: "auto", serviceTier: null });
  const previous = { ...draft, text: "", images: [] };
  assert.deepEqual(restoreWorkspaceDraft(previous, pending), { ...previous, uncertain: true });
  assert.deepEqual(restoreWorkspaceDraft(undefined, { id: "fixture", args: { text: {}, images: {}, effort: 1, serviceTier: false } }), { text: "", images: [], uncertain: true, settings: {} });
  assert.deepEqual(restoreWorkspaceDraft(undefined, null), { text: "", images: [], uncertain: false, settings: {} });
});

test("发送规则拒绝空草稿、缺失图片与未确认结果，第一轮结果分别保留可重试和未知语义", () => {
  assert.equal(canSendDraft(draft), true);
  assert.equal(canSendDraft({ ...draft, text: "" }), true);
  for (const patch of [{ text: "  ", images: [] }, { images: [{ ...image, url: "" }] }, { uncertain: true }]) assert.equal(canSendDraft({ ...draft, ...patch }), false);
  assert.deepEqual(firstTurnDraft(draft, "accepted"), { text: "", images: [], uncertain: false, settings: {} });
  for (const result of ["not-started", "not-requested"]) assert.deepEqual(firstTurnDraft(draft, result), draft);
  for (const result of ["outcome-unknown", "future-result"]) assert.deepEqual(firstTurnDraft(draft, result), { ...draft, uncertain: true });
});

test("会话事件先校验嵌套显示数据，未知事件忽略，损坏的已知事件明确失败", () => {
  const state = { id: "thread", historyComplete: true, serviceTier: null, turns: [{ id: "turn", status: "completed", messages: [{ role: "user", kind: "userMessage", text: "hello", attachments: [{ name: "fixture", url: image.url }] }] }], requests: [{ id: 1, method: "question", supported: true, params: { questions: [{ id: "q", question: "问题", options: [{ label: "选项" }] }], availableDecisions: ["accept"] } }] };
  assert.deepEqual(conversationEvent({ type: "state", state }), { type: "state", state });
  assert.deepEqual(conversationEvent({ type: "disconnected", message: "离线" }), { type: "disconnected", message: "离线" });
  assert.equal(conversationEvent({ type: "heartbeat" }), null);
  for (const value of [null, [], { type: "disconnected", message: {} }, { type: "state" }, ...[
    { turns: null }, { turns: [{ id: "t", status: "completed", messages: [null] }] }, { serviceTier: 3 },
    { requests: [{ id: 1, method: "q", supported: true, params: { questions: [null] } }] },
    { requests: [{ id: 1, method: "q", supported: true, params: { availableDecisions: [3] } }] },
  ].map(patch => ({ type: "state", state: { ...state, ...patch } }))]) assert.throws(() => conversationEvent(value), /会话数据无效/);
});

test("后端可空字段原样保留，未完成轮次与缺少原生元数据仍能读取", () => {
  // 对应 remote_control/protocol.rs 的 view_metadata、turn_view 和 item_view。
  const state = { id: "thread", title: null, cwd: null, model: null, effort: null, serviceTier: null, status: null,
    permissionMode: "custom", historyComplete: true, turns: [{ id: null, status: null, startedAt: null, completedAt: null,
      messages: [{ id: null, role: "user", kind: "userMessage", text: "hello", status: null, attachments: [{ name: "图片", url: null }] }] }],
    requests: [{ id: 1, method: "approval", supported: true, params: { command: null, reason: null, questions: null, availableDecisions: null } }] };
  assert.deepEqual(conversationEvent({ type: "state", state }), { type: "state", state });
});
