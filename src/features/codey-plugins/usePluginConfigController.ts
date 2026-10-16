import { useEffect, useRef, useState } from "react";
import { errorText } from "../../appUtils";
import type { CodeyPluginConfigFile } from "../../codeyPlugins";
import { parsePluginConfigDocument, type PluginConfigDocument, type PluginConfigEntry } from "../../pluginConfigDocument";
import { useStableEvent } from "../../useStableEvent";
import { codeyPluginsRequests } from "./requests";
import { hasInvalidEdits, serializeConfigEdits, valueToken } from "./state";
import type { PluginConfigOptions } from "./types";

export function usePluginConfigController({ plugin, active = true, onClose, onChanged }: PluginConfigOptions) {
  const [file, setFile] = useState<CodeyPluginConfigFile | null>(null);
  const [document, setDocument] = useState<PluginConfigDocument | null>(null);
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState<"close" | "reload" | null>(null);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const reading = useRef(false);
  const mounted = useRef(false);
  const session = useRef<object | null>(null);
  const epoch = useRef(0);
  const draft = useRef<ReadonlyMap<string, string>>(new Map());
  const needsReconcile = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    session.current = active ? {} : null;
    return () => { session.current = null; epoch.current++; reading.current = false; };
  }, [active]);

  const load = useStableEvent(async () => {
    const scope = session.current;
    if (!active || !scope || pending.current) return;
    const generation = ++epoch.current;
    const current = () => mounted.current && session.current === scope && generation === epoch.current;
    reading.current = true;
    setLoading(true); setError(""); setDiscard(null); setFile(null); setDocument(null);
    draft.current = new Map(); setEdits(draft.current);
    needsReconcile.current = false;
    try {
      const next = await codeyPluginsRequests.configFile(plugin);
      if (!current()) return;
      setFile(next);
      try { setDocument(parsePluginConfigDocument(next.content)); }
      catch (cause) { setError(`${errorText(cause)} 请修正配置文件后重新加载。`); }
    } catch (cause) { if (current()) setError(errorText(cause)); }
    finally { if (current()) { reading.current = false; setLoading(false); } }
  });
  useEffect(() => {
    if (!active || pending.current) return;
    // 隐藏期间的写入不重放；保留草稿与原摘要，重新加载由用户显式确认。
    if (needsReconcile.current && draft.current.size) {
      setError("保存操作已结束，请重新加载配置确认结果；当前草稿已保留。");
    } else if (!draft.current.size) void load();
  }, [active, revision, load]);

  const request = useStableEvent((action: "close" | "reload") => {
    if (!active || !session.current || pending.current) return;
    if (draft.current.size) setDiscard(action);
    else if (action === "close") onClose();
    else void load();
  });
  const confirmDiscard = useStableEvent(() => {
    if (!active || !session.current || pending.current) return;
    if (discard === "close") onClose();
    else if (discard === "reload") void load();
  });
  function edit(entry: PluginConfigEntry, value: string) {
    if (!active || !session.current || pending.current || reading.current) return;
    const next = new Map(draft.current);
    if (value === valueToken(entry)) next.delete(entry.id); else next.set(entry.id, value);
    draft.current = next; setEdits(next);
  }
  const save = useStableEvent(async () => {
    const scope = session.current;
    if (!active || !scope || pending.current || reading.current || loading || !file || !document || !draft.current.size) return;
    let content: string;
    try { content = serializeConfigEdits(document, draft.current); }
    catch (cause) { setError(errorText(cause)); return; }
    pending.current = true; setSaving(true); setError(""); setDiscard(null);
    const current = () => mounted.current && session.current === scope;
    try {
      const result = await codeyPluginsRequests.saveConfigFile(plugin.id, content, file.sha256);
      if (current()) { onChanged(result); onClose(); }
      else needsReconcile.current = true;
    } catch (cause) {
      if (current()) setError(errorText(cause));
      else needsReconcile.current = true;
    } finally {
      pending.current = false;
      if (mounted.current) {
        setSaving(false);
        if (!current()) setRevision(value => value + 1);
      }
    }
  });

  return { file, document, edits, loading, saving, error, discard, request, confirmDiscard,
    cancelDiscard: () => setDiscard(null), edit, save,
    canSave: active && !saving && !loading && !!document && !!edits.size && !hasInvalidEdits(document.entries, edits),
    isSaving: () => pending.current };
}
