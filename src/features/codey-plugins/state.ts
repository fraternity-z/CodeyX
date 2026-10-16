import { errorText } from "../../appUtils";
import type { CodeyPlugin } from "../../codeyPlugins";
import { isEditableConfigArray, serializePluginConfigDocument, validatePluginConfigValue,
  type PluginConfigDocument, type PluginConfigEntry } from "../../pluginConfigDocument";

export function filterPlugins(plugins: CodeyPlugin[], query: string): CodeyPlugin[] {
  const q = query.trim().toLowerCase();
  if (!q) return plugins;
  return plugins.filter(plugin => [plugin.name, plugin.id, plugin.description ?? "", ...plugin.capabilities]
    .some(value => value.toLowerCase().includes(q)));
}

export const valueToken = (entry: PluginConfigEntry) => entry.kind === "string" ? JSON.stringify(entry.valueText)
  : isEditableConfigArray(entry) ? entry.valueText.replace(/"(?:\\.|[^"\\])*"|[\t\n\r ]+/g, token => token.startsWith('"') ? token : "") : entry.valueText;

function decodedValue(entry: PluginConfigEntry, token: string): string {
  if (entry.kind !== "string") return token;
  let value: unknown;
  try { value = JSON.parse(token); } catch { throw new Error("请输入完整的 JSON 字符串，包含双引号；换行请写为 \\n。"); }
  if (typeof value !== "string") throw new Error("此配置项必须是带双引号的 JSON 字符串。");
  return value;
}

export function tokenError(entry: PluginConfigEntry, token: string): string | undefined {
  try { return validatePluginConfigValue(entry, decodedValue(entry, token)); }
  catch (cause) { return errorText(cause); }
}

export function hasInvalidEdits(entries: PluginConfigEntry[], edits: ReadonlyMap<string, string>): boolean {
  return entries.some(entry => edits.has(entry.id) ? !!tokenError(entry, edits.get(entry.id)!) : hasInvalidEdits(entry.children, edits));
}

export function serializeConfigEdits(configDocument: PluginConfigDocument, edits: ReadonlyMap<string, string>): string {
  const values = new Map<string, string>();
  const collect = (entries: PluginConfigEntry[]) => entries.forEach(entry => {
    if (edits.has(entry.id)) {
      const token = edits.get(entry.id)!;
      const validation = tokenError(entry, token);
      if (validation) throw new Error(`${JSON.stringify(entry.path)}：${validation}`);
      values.set(entry.id, decodedValue(entry, token));
    } else collect(entry.children);
  });
  collect(configDocument.entries);
  return serializePluginConfigDocument(configDocument, values);
}
