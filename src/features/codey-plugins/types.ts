import type { CodeyPlugin, CodeyPluginsResult } from "../../codeyPlugins";

export type PluginFeedback = { tone: "success" | "warning"; text: string };
export type PluginImportSource = { file: File } | { path: string };
export type PluginConfirmation = { kind: "enable" | "uninstall"; plugin: CodeyPlugin };
export type PluginConfigOptions = {
  plugin: CodeyPlugin;
  active?: boolean;
  onClose: () => void;
  onChanged: (result: CodeyPluginsResult) => void;
};
