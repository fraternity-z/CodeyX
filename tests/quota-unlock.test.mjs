import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/quota-unlock.js", import.meta.url), "utf8");

function createRuntime(initialValue = null) {
  const values = new Map(initialValue === null ? [] : [["codeyQuotaUnlock", initialValue]]);
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.sent = [];
      this.listeners = [];
    }

    send(data) { this.sent.push(data); }
    addEventListener(type, listener) {
      if (type === "message") this.listeners.push(listener);
    }
    receive(data) {
      const event = { data };
      this.listeners.forEach((listener) => listener(event));
      return event.data;
    }
  }
  const window = { localStorage, WebSocket: MockWebSocket };
  window.window = window;
  const context = { window, localStorage, console };
  vm.runInNewContext(source, context);
  return { context, window, localStorage };
}

function parsePayload(context, payload) {
  const value = vm.runInNewContext(`JSON.parse(${JSON.stringify(JSON.stringify(payload))})`, context);
  return JSON.parse(JSON.stringify(value));
}

test("quota unlock clears send blockers without changing official usage or credits", () => {
  const { context, window } = createRuntime();
  const payload = {
    rate_limit: { allowed: false, limit_reached: true },
    primary_window: { used_percent: 100, reset_at: 1 },
    spend_control: { reached: true },
    credits: { has_credits: false, unlimited: false, balance: 0 },
    blocked_features: [{ name: "send" }, { name: "tpp_send" }, { name: "other" }],
    rate_limit_reached_type: "weekly",
  };
  const value = parsePayload(context, payload);

  assert.equal(value.rate_limit.allowed, true);
  assert.equal(value.rate_limit.limit_reached, false);
  assert.deepEqual(value.primary_window, payload.primary_window);
  assert.equal(value.spend_control.reached, false);
  assert.deepEqual(value.credits, payload.credits);
  assert.deepEqual(value.blocked_features, [{ name: "other" }]);
  assert.equal(value.rate_limit_reached_type, null);
  assert.equal(window.__codeyQuotaUnlock.status().sanitized, 1);
});

test("quota unlock preserves changing REST and SSE usage snapshots, including exhausted windows", () => {
  for (const wrap of [(usage) => usage, (usage) => ({ type: "usage.snapshot", usage })]) {
    const { context } = createRuntime();
    for (const usedPercent of [0, 2.5, 3, 38.75, 97, 100, 125]) {
      const usage = {
        plan_type: "pro",
        rate_limit: {
          allowed: usedPercent < 100,
          limit_reached: usedPercent >= 100,
          primary_window: { used_percent: usedPercent, reset_at: 1, limit_window_seconds: 18000 },
          secondary_window: { used_percent: usedPercent, reset_at: 1800000000, limit_window_seconds: 604800 },
        },
        additional_rate_limits: [{ rate_limit: {
          primary_window: { used_percent: usedPercent, reset_at: null },
          secondary_window: null,
        } }],
        code_review_rate_limit: { primary_window: { used_percent: usedPercent, reset_at: "unknown" } },
        credits: { has_credits: false, unlimited: false, balance: "0" },
      };
      const payload = wrap(usage);
      const value = parsePayload(context, payload);
      const expected = structuredClone(payload);
      const expectedUsage = expected.usage ?? expected;
      expectedUsage.rate_limit.allowed = true;
      expectedUsage.rate_limit.limit_reached = false;
      assert.deepEqual(value, expected);
    }
  }
});

test("quota unlock preserves app-server rate limits and billing across all limit buckets", () => {
  const { context } = createRuntime();
  const snapshot = {
    primary: { usedPercent: 45.5, resetAt: 1, windowDurationMins: 300 },
    secondary: { usedPercent: 100, resetsAt: 1800000000, windowDurationMins: 10080 },
    credits: { hasCredits: false, unlimited: false, balance: "12.50" },
    planType: "pro",
  };
  const payload = {
    rateLimits: snapshot,
    rateLimitsByLimitId: { codex: snapshot, reviews: { ...snapshot, primary: null } },
  };
  assert.deepEqual(parsePayload(context, payload), payload);
});

test("quota unlock preserves WebSocket read and update measurements while clearing send blockers", () => {
  const { window } = createRuntime();
  const socket = new window.WebSocket("ws://127.0.0.1/test", ["jsonrpc"]);
  const payload = {
    rateLimits: {
      primary: { usedPercent: 68, resetAt: 1 },
      secondary: { usedPercent: 100, resetsAt: 1800000000 },
      credits: { has_credits: false, unlimited: false, balance: 0 },
      rateLimitReachedType: "weekly",
    },
    rateLimitsByLimitId: { codex: { secondary: { usedPercent: 100, resetsAt: 1800000000 } } },
  };
  const expected = structuredClone(payload);
  expected.rateLimits.rateLimitReachedType = null;
  const request = JSON.stringify({ id: 0, method: "account/rateLimits/read" });
  socket.send(request);
  const read = { id: 0, result: payload };
  const update = { method: "account/rateLimits/updated", params: payload };
  assert.deepEqual(JSON.parse(socket.receive(JSON.stringify(read))), { id: 0, result: expected });
  assert.deepEqual(JSON.parse(socket.receive(JSON.stringify(update))), {
    method: "account/rateLimits/updated", params: expected,
  });
  assert.deepEqual(socket.sent, [request]);
  assert.deepEqual(socket.protocols, ["jsonrpc"]);
  assert.equal(window.WebSocket.OPEN, 1);
  assert.equal(window.__codeyQuotaUnlock.status().sanitized, 2);
});

test("quota unlock leaves unrelated payloads and malformed WebSocket frames intact", () => {
  const { context, window } = createRuntime();
  const payload = { primary: { usedPercent: 95 }, credits: { balance: 0 }, allowed: false };
  assert.deepEqual(parsePayload(context, payload), payload);
  const socket = new window.WebSocket("ws://127.0.0.1/test");
  for (const frame of ["not JSON rateLimits", JSON.stringify({ id: 1, error: { message: "rateLimits unavailable" } })]) {
    assert.equal(socket.receive(frame), frame);
  }
  assert.throws(() => vm.runInNewContext('JSON.parse("invalid")', context), { name: "SyntaxError" });
  assert.equal(window.__codeyQuotaUnlock.status().sanitized, 0);
});

test("quota unlock can be disabled before the document is loaded", () => {
  const { context, window } = createRuntime("off");
  const payload = {
    rate_limit: { allowed: false, limit_reached: true },
    primary_window: { used_percent: 100, reset_at: 1 },
    credits: { has_credits: false, unlimited: false, balance: 0 },
  };
  const value = parsePayload(context, payload);

  assert.deepEqual(value, payload);
  assert.equal(window.__codeyQuotaUnlock.status().enabled, false);
});
