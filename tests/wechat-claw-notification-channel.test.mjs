import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const typesSource = readFileSync(
  new URL("../src/features/notifications/types.ts", import.meta.url),
  "utf8",
);
const registrySource = readFileSync(
  new URL("../src/features/notifications/channelRegistry.tsx", import.meta.url),
  "utf8",
);
const cardSource = readFileSync(
  new URL("../src/features/notifications/NotificationChannelsCard.tsx", import.meta.url),
  "utf8",
);
const editorSource = readFileSync(
  new URL("../src/features/notifications/WechatClawChannelEditor.tsx", import.meta.url),
  "utf8",
);
const mainSource = readFileSync(
  new URL("../src/dev/mockApi.ts", import.meta.url),
  "utf8",
);
const controllerSource = readFileSync(new URL("../src/features/notifications/useWechatClawLoginController.ts", import.meta.url), "utf8");
const requestsSource = readFileSync(new URL("../src/features/notifications/requests.ts", import.meta.url), "utf8");
const stateSource = readFileSync(new URL("../src/features/notifications/state.ts", import.meta.url), "utf8");

test("WeChat ClawBot is a scan-bound, token-protected notification channel", () => {
  assert.match(typesSource, /"wechatClaw"/);
  assert.match(
    registrySource,
    /wechatClaw:\s*\{[\s\S]*?Editor: WechatClawChannelEditor/,
  );
  assert.match(registrySource, /displayName: "微信 ClawBot"/);
  assert.match(requestsSource, /invoke<WechatClawLoginStartResult>\(\s*"start_wechat_claw_login"/);
  assert.match(requestsSource, /"poll_wechat_claw_login"/);
  assert.match(controllerSource, /window\.setTimeout\(\(\) => void poll\(\), 1_200\)/);
  assert.match(typesSource, /contextTokenConfigured: boolean/);
  assert.match(typesSource, /sessionStatus\?: NotificationChannelSessionStatus/);
  assert.match(typesSource, /status: "wait" \| "scanned" \| "activating"/);
  assert.match(stateSource, /contextTokenConfigured: true/);
  assert.match(stateSource, /sessionStatus: "active"/);
  assert.match(editorSource, /qrCodeImageUrl/);
  assert.doesNotMatch(editorSource, /解除已保存绑定|clearBotToken: true|clearContextToken: true/);
  assert.match(editorSource, /发送一条消息完成激活/);
  assert.match(editorSource, /登录已失效，请重新扫码后保存配置/);
  assert.match(cardSource, /label: "登录失效", variant: "warning"/);
  assert.match(
    stateSource,
    /channel\.contextToken\.trim\(\) \|\| \(channel\.contextTokenConfigured/,
  );
  assert.match(stateSource, /channel\.sessionStatus !== "expired"/);
  assert.match(
    mainSource,
    /channel\.sessionStatus !== "expired"[\s\S]*?channel\.urlConfigured/,
  );
  assert.doesNotMatch(editorSource, /type="password"/);
  assert.match(
    mainSource,
    /channel\.kind === "telegram" \|\| channel\.kind === "wechatClaw"/,
  );
});
