import type { Profile } from "../../App.types";
import { MAX_ROUTE_NAME_CHARACTERS } from "../../officialRouteSettings";
import { MAX_ROUTE_SHORT_NAME_CHARACTERS } from "../../routeShortNames";
import { validateOutboundApiUrl } from "../../urlValidation";

/** New API 的「复制连接串」只用于填充草稿，仍通过正常保存流程校验。 */
export function importNewApiConnection(text: string, draft: Profile): Partial<Profile> {
  if (text.length > 64 * 1024) throw new Error("连接串过长，请重新复制 New API 连接信息");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let value: unknown;
  try { value = JSON.parse(text.slice(start, end + 1)); }
  catch { throw new Error("无法识别连接串，请粘贴 New API 的「复制连接串」内容"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("_type" in value) || value._type !== "newapi_channel_conn"
    || !("key" in value) || typeof value.key !== "string" || !value.key.trim()
    || !("url" in value) || typeof value.url !== "string" || !value.url.trim()) {
    throw new Error("连接串需包含 New API 类型、有效地址和 API Key");
  }
  const baseUrl = value.url.trim();
  const urlError = validateOutboundApiUrl(baseUrl);
  if (urlError) throw new Error(urlError);
  const hostname = new URL(baseUrl).hostname;
  const labels = hostname.split(".");
  const base = labels.length > 1 && labels[0] === "api" ? labels[1] : labels[0];
  const shortName = Array.from(base.replace(/[^\p{L}\p{N}]/gu, ""))
    .slice(0, MAX_ROUTE_SHORT_NAME_CHARACTERS).join("");
  return {
    baseUrl, apiKey: value.key.trim(), clearApiKey: false,
    name: draft.name.trim() ? draft.name : Array.from(hostname).length <= MAX_ROUTE_NAME_CHARACTERS ? hostname : "",
    shortName: draft.shortName.trim() ? draft.shortName : shortName,
  };
}
