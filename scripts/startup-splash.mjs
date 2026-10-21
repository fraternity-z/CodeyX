import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadStartupSplash(root) {
  const markup = readFileSync(join(root, "backend/src/codex_startup_splash.html"), "utf8");
  const art = readFileSync(join(root, "public/startup-art/gpt-claude.webp"));
  return markup.replaceAll("__CODEY_STARTUP_ART__", `data:image/webp;base64,${art.toString("base64")}`);
}
