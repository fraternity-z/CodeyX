import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

// A compiled mock fixture avoids dev-server module discovery in workspaces
// containing large native build trees. This output is never a release asset.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "output/playwright/compiled-fixture");
await build({
  root,
  configFile: join(root, "vite.config.ts"),
  define: { "import.meta.env.DEV": "true", "import.meta.env.PROD": "false" },
  build: {
    outDir, emptyOutDir: false, target: "es2022",
    rollupOptions: {
      input: ["ui-browser.html", "remote-control-browser.html", "remote-workspace-browser.html"].map(file => join(root, "tests", file)),
    },
  },
});
const server = await preview({
  root, configFile: false, base: "/codey/", build: { outDir },
  preview: { host: "127.0.0.1", port: 1422, strictPort: true },
});
server.printUrls();
