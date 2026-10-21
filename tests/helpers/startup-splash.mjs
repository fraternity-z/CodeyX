import { fileURLToPath } from "node:url";
import { loadStartupSplash } from "../../scripts/startup-splash.mjs";
import { normalizeLineEndings } from "./read-source.mjs";

export const loadStartupSplashMarkup = () =>
  normalizeLineEndings(loadStartupSplash(fileURLToPath(new URL("../../", import.meta.url))));
