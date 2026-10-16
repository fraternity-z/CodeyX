import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);
const updateSource = readFileSync(
  new URL("../src/useAppUpdates.ts", import.meta.url),
  "utf8",
);
const dialogSource = readFileSync(
  new URL("../src/features/notifications/useNotificationChannelController.ts", import.meta.url),
  "utf8",
);

test("notification dialog waits for the channel configuration to persist", () => {
  assert.match(dialogSource, /onSave: \(channel: NotificationChannel\) => Promise<boolean>/);
  assert.match(dialogSource, /if \(await onSave\(draft\) && current\(\)\) onOpenChange\(false\)/);
  assert.match(appSource, /useNotificationsController\(/);
  assert.doesNotMatch(appSource, /function (?:persistNotificationChannels|addNotificationChannel|updateNotificationChannel|removeNotificationChannel)/);
});

test("installing an update saves pending settings first", () => {
  assert.match(appSource, /beforeInstall: async \(\) => \{[\s\S]*?await persist\(config\)/);
  assert.match(updateSource, /await beforeInstall\(\);[\s\S]*?install_downloaded_update/);
});
