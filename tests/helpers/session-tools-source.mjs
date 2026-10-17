import { readFileSync } from "node:fs";

// Match the host's ordering: the native adapter is independent of the optional
// session UI and is already installed when that UI is loaded or reinstalled.
export function readSessionToolsSource() {
  return ["codex-runtime-adapter.js", "codey-inject.js"].map((name) =>
    readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8"),
  ).join("\n");
}
