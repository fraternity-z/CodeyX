import { invoke } from "../../api";
import { parseCodeyPluginsResult, type CodeyPlugin, type CodeyPluginConfigFile, type CodeyPluginPreview } from "../../codeyPlugins";
import { uploadPluginPackage } from "../../pluginPackageImport";

export const codeyPluginsRequests = {
  list: async () => parseCodeyPluginsResult(await invoke("list_codey_plugins")),
  setEnabled: async (pluginId: string, enabled: boolean) =>
    parseCodeyPluginsResult(await invoke("set_codey_plugin_enabled", { pluginId, enabled })),
  install: async (preview: CodeyPluginPreview) =>
    parseCodeyPluginsResult(await invoke("install_codey_plugin", { path: preview.path, sha256: preview.sha256 })),
  uninstall: async (pluginId: string, removeData: boolean) =>
    parseCodeyPluginsResult(await invoke("uninstall_codey_plugin", { pluginId, removeData })),
  selectPackage: () => invoke<CodeyPluginPreview | null>("select_codey_plugin_package"),
  inspectPath: (path: string) => invoke<CodeyPluginPreview>("inspect_codey_plugin", { path }),
  upload: (file: File, signal: AbortSignal) =>
    uploadPluginPackage(file, args => invoke("inspect_codey_plugin", args), signal),
  discardUpload: (uploadId: string) => invoke("inspect_codey_plugin", { discardUpload: uploadId }),
  openDirectory: (pluginId: string) => invoke("open_codey_plugin_directory", { pluginId }),
  openLogs: (pluginId: string) => invoke<{ status: "ok" | "already_open" }>("open_codey_plugin_logs", { pluginId }),
  clearLogs: async (pluginId: string) =>
    parseCodeyPluginsResult(await invoke("clear_codey_plugin_logs", { pluginId, confirmed: true })),
  configFile: async (plugin: Pick<CodeyPlugin, "id" | "version">) => {
    const next = await invoke<CodeyPluginConfigFile>("get_codey_plugin_config_file", { pluginId: plugin.id });
    if (!next || next.pluginId !== plugin.id || next.version !== plugin.version || typeof next.path !== "string"
      || typeof next.content !== "string" || typeof next.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(next.sha256)) {
      throw new Error("配置文件响应无效或插件版本已变化，请重新打开配置。");
    }
    return next;
  },
  saveConfigFile: async (pluginId: string, content: string, expectedSha256: string) =>
    parseCodeyPluginsResult(await invoke("save_codey_plugin_config_file", { pluginId, content, expectedSha256 })),
};
