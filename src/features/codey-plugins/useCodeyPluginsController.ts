import { useEffect, useRef, useState } from "react";
import { errorText } from "../../appUtils";
import type { CodeyPlugin, CodeyPluginPreview, CodeyPluginsResult } from "../../codeyPlugins";
import { validateDroppedPluginFiles } from "../../pluginPackageImport";
import { useStableEvent } from "../../useStableEvent";
import { codeyPluginsRequests } from "./requests";
import { filterPlugins } from "./state";
import type { PluginConfirmation, PluginFeedback, PluginImportSource } from "./types";

type Options = { active: boolean; onNotice: (notice: PluginFeedback) => void };
type Current = () => boolean;

export function useCodeyPluginsController({ active, onNotice }: Options) {
  const [result, setResult] = useState<CodeyPluginsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [known, setKnown] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importError, setImportError] = useState("");
  const [preview, setPreview] = useState<CodeyPluginPreview | null>(null);
  const [importStep, setImportStep] = useState<"checking" | "installing" | "">("");
  const [importFileName, setImportFileName] = useState("");
  const [importResult, setImportResult] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PluginConfirmation | null>(null);
  const [removeData, setRemoveData] = useState(false);
  const [clearLogsPlugin, setClearLogsPlugin] = useState<CodeyPlugin | null>(null);
  const [clearLogsError, setClearLogsError] = useState("");
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const session = useRef<object | null>(null);
  const pending = useRef(false);
  const knownState = useRef(false);
  const readGeneration = useRef(0);
  const configurationSaved = useRef(false);
  const retrySource = useRef<PluginImportSource | null>(null);
  const uploadedPackage = useRef<string | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const installing = useRef(false);
  const completedImport = useRef(false);

  const discardUpload = (uploadId: string | null) => {
    if (uploadId) void codeyPluginsRequests.discardUpload(uploadId).catch(() => undefined);
  };
  const discardUploadedPackage = useStableEvent(() => {
    discardUpload(uploadedPackage.current);
    uploadedPackage.current = null;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadAbort.current?.abort();
      // 安装请求仍可能读取暂存包，等请求结束再释放。
      if (!installing.current) discardUploadedPackage();
    };
  }, [discardUploadedPackage]);
  useEffect(() => {
    session.current = active ? {} : null;
    knownState.current = false;
    setKnown(false); setConfirm(null); setClearLogsPlugin(null);
    return () => {
      session.current = null;
      knownState.current = false;
      readGeneration.current++;
      uploadAbort.current?.abort();
    };
  }, [active]);

  const notice = useStableEvent(onNotice);
  const accept = useStableEvent((next: CodeyPluginsResult) => {
    setResult(next); setKnown(true); knownState.current = true; setError("");
  });
  const readList = useStableEvent(async (current: Current) => {
    const generation = ++readGeneration.current;
    const valid = () => current() && generation === readGeneration.current;
    knownState.current = false;
    setKnown(false); setLoading(true); setConfirm(null);
    try {
      const next = await codeyPluginsRequests.list();
      if (valid()) accept(next);
      return valid() ? next : undefined;
    } catch (cause) {
      if (valid()) setError(errorText(cause));
      throw cause;
    } finally { if (valid()) setLoading(false); }
  });
  const refresh = useStableEvent(async () => {
    const scope = session.current;
    if (!active || !scope || pending.current) return;
    setError("");
    try { await readList(() => mounted.current && session.current === scope); }
    catch { /* readList 已记录当前读取错误。 */ }
  });
  useEffect(() => {
    if (!active || pending.current) return;
    if (completedImport.current) {
      completedImport.current = false;
      retrySource.current = null;
      setImportOpen(false); setPreview(null); setImportError("");
    }
    void refresh();
  }, [active, revision, refresh]);

  const run = useStableEvent(async (
    action: (current: Current) => Promise<void>,
    onError: (message: string) => void = setError,
    allowUnknown = false,
  ) => {
    const scope = session.current;
    if (!active || !scope || pending.current || (!knownState.current && !allowUnknown)) return;
    pending.current = true;
    readGeneration.current++;
    setBusy(true); setLoading(false); setError("");
    const current = () => mounted.current && session.current === scope;
    try { await action(current); }
    catch (cause) { if (current()) onError(errorText(cause)); }
    finally {
      // 隐藏不取消后端写入，也不能提前释放操作锁。
      pending.current = false;
      if (mounted.current) {
        setBusy(false); setImportStep("");
        if (!current()) setRevision(value => value + 1);
      }
    }
  });
  const mutate = useStableEvent(async (operation: () => Promise<CodeyPluginsResult>, current: Current, touchesRoutes = false) => {
    try {
      const next = await operation();
      if (current()) accept(next);
      return true;
    } catch (cause) {
      // 错误或超时不证明后台未执行，只刷新状态，不自动重放写入。
      if (current()) {
        try { await readList(current); } catch { /* 保留未知状态，等待显式刷新。 */ }
      }
      throw cause;
    } finally {
      // 仅发出失效通知；线路功能自行读取，不能采纳旧页面的返回数据。
      if (touchesRoutes) window.dispatchEvent(new CustomEvent("codey:plugin-routes-changed"));
    }
  });
  const available = () => active && !!session.current && knownState.current && !pending.current;
  const hasPlugin = (plugin: CodeyPlugin) => result?.plugins.some(item => item.id === plugin.id && item.version === plugin.version);

  const changeEnabled = useStableEvent((plugin: CodeyPlugin, enabled: boolean) => {
    if (!available() || !hasPlugin(plugin)) return;
    if (enabled) { setConfirm({ kind: "enable", plugin }); return; }
    return run(async current => {
      await mutate(() => codeyPluginsRequests.setEnabled(plugin.id, false), current, true);
      if (current()) notice({ tone: "success", text: `插件「${plugin.name}」已停用` });
    });
  });
  const restartPlugin = useStableEvent((plugin: CodeyPlugin) => {
    if (!hasPlugin(plugin)) return;
    return run(async current => {
      await mutate(() => codeyPluginsRequests.setEnabled(plugin.id, false), current, true);
      if (!current()) return;
      try { await mutate(() => codeyPluginsRequests.setEnabled(plugin.id, true), current, true); }
      catch (cause) { throw new Error(`重新启用失败：${errorText(cause)}。请检查状态后重试启用。`); }
      if (current()) notice({ tone: "success", text: "插件已重新启用，变更已生效" });
    });
  });
  const requestUninstall = (plugin: CodeyPlugin) => {
    if (!available() || !hasPlugin(plugin) || plugin.enabled) return;
    setRemoveData(false); setConfirm({ kind: "uninstall", plugin });
  };
  const confirmOperation = useStableEvent(() => {
    if (!confirm || !hasPlugin(confirm.plugin)) return;
    const { kind, plugin } = confirm;
    return run(async current => {
      await mutate(() => kind === "enable" ? codeyPluginsRequests.setEnabled(plugin.id, true)
        : codeyPluginsRequests.uninstall(plugin.id, removeData), current, true);
      if (!current()) return;
      setConfirm(null);
      if (kind === "uninstall") setEditId(null);
      notice({ tone: "success", text: kind === "enable" ? `插件「${plugin.name}」已启用` : `插件「${plugin.name}」已成功卸载` });
    });
  });

  const clearPreview = useStableEvent(() => {
    if (!active || pending.current) return;
    discardUploadedPackage(); retrySource.current = null;
    setPreview(null); setImportError(""); setImportFileName("");
  });
  const openImport = useStableEvent(() => {
    if (!available()) return;
    clearPreview(); setImportResult(""); setConfirm(null); setImportOpen(true);
  });
  const closeImport = useStableEvent(() => {
    if (!active || pending.current) return;
    clearPreview(); setImportOpen(false);
  });
  const inspectImport = useStableEvent((source: PluginImportSource) => run(async current => {
    discardUploadedPackage(); retrySource.current = source;
    setPreview(null); setImportError(""); setImportResult("");
    setImportFileName("file" in source ? source.file.name : ""); setImportStep("checking");
    const controller = new AbortController();
    uploadAbort.current = controller;
    try {
      const inspected = "file" in source
        ? await codeyPluginsRequests.upload(source.file, controller.signal)
        : await codeyPluginsRequests.inspectPath(source.path);
      const uploadId = "uploadId" in inspected ? inspected.uploadId as string : null;
      if (!current() || controller.signal.aborted) { discardUpload(uploadId); return; }
      uploadedPackage.current = uploadId;
      setPreview(inspected);
    } finally { if (uploadAbort.current === controller) uploadAbort.current = null; }
  }, message => setImportError(`检查插件包失败：${message} 请修正文件后重试，或重新选择插件包。`), true));
  const selectPackage = useStableEvent(() => run(async current => {
    setImportStep("checking"); setImportError("");
    try {
      const selected = await codeyPluginsRequests.selectPackage();
      if (!current() || !selected) return;
      discardUploadedPackage(); retrySource.current = { path: selected.path };
      setImportFileName(""); setPreview(selected);
    } catch (cause) { if (current()) setPreview(null); throw cause; }
  }, message => setImportError(`检查插件包失败：${message} 请重新选择插件包。`), true));
  const inspectPath = (path: string) => { if (path.trim()) return inspectImport({ path: path.trim() }); };
  const droppedFiles = useStableEvent((files: File[]) => {
    if (!available() || editId || confirm || clearLogsPlugin) return;
    setImportOpen(true); setConfirm(null); setImportResult("");
    const invalid = validateDroppedPluginFiles(files);
    if (invalid) {
      discardUploadedPackage(); retrySource.current = files.length === 1 ? { file: files[0] } : null;
      setPreview(null); setImportFileName(files.length === 1 ? files[0].name : ""); setImportError(invalid);
    } else return inspectImport({ file: files[0] });
  });
  const confirmImport = useStableEvent(() => {
    if (!preview || result?.plugins.some(plugin => plugin.id === preview.manifest.id && plugin.version === preview.manifest.version)) return;
    const selected = preview;
    return run(async current => {
      setImportStep("installing"); setImportError("");
      const latest = knownState.current ? result : await readList(current);
      if (!current() || !latest) return;
      const installed = latest.plugins.find(plugin => plugin.id === selected.manifest.id);
      if (installed?.version === selected.manifest.version) return;
      installing.current = true;
      try {
        await mutate(() => codeyPluginsRequests.install(selected), current);
        discardUploadedPackage(); retrySource.current = null;
        if (!current()) { completedImport.current = true; return; }
        setImportOpen(false); setPreview(null); setSearchQuery("");
        const message = installed ? `插件「${selected.manifest.name}」升级成功。`
          : `插件「${selected.manifest.name}」安装成功，默认处于停用状态。`;
        setImportResult(message); notice({ tone: "success", text: message });
      } finally {
        installing.current = false;
        if (!mounted.current) discardUploadedPackage();
      }
    }, message => setImportError(`导入插件失败：${message} 可重试导入或重新选择插件包。`), true);
  });
  const retryImport = () => preview ? confirmImport() : retrySource.current ? inspectImport(retrySource.current) : undefined;

  const openLogs = (plugin: CodeyPlugin) => run(async current => {
    const opened = await codeyPluginsRequests.openLogs(plugin.id);
    if (current()) notice(opened.status === "already_open"
      ? { tone: "warning", text: `${plugin.name} 当前已有日志窗口` }
      : { tone: "success", text: `已在本机终端打开 ${plugin.name} 的实时日志` });
  });
  const openDirectory = (plugin: CodeyPlugin) => run(async () => { await codeyPluginsRequests.openDirectory(plugin.id); });
  const requestClearLogs = (plugin: CodeyPlugin) => {
    if (available() && hasPlugin(plugin)) { setClearLogsError(""); setClearLogsPlugin(plugin); }
  };
  const clearLogs = useStableEvent(() => {
    if (!clearLogsPlugin || !hasPlugin(clearLogsPlugin)) return;
    return run(async current => {
      setClearLogsError("");
      await mutate(() => codeyPluginsRequests.clearLogs(clearLogsPlugin.id), current);
      if (current()) {
        notice({ tone: "success", text: `${clearLogsPlugin.name} 的现有运行日志已清除` });
        setClearLogsPlugin(null);
      }
    }, setClearLogsError);
  });
  const openConfig = (plugin: CodeyPlugin) => {
    if (available() && hasPlugin(plugin)) { configurationSaved.current = false; setEditId(plugin.id); }
  };
  const configChanged = useStableEvent((next: CodeyPluginsResult) => {
    if (!active || !session.current || pending.current) return;
    readGeneration.current++; setLoading(false); accept(next);
    configurationSaved.current = true;
    const editing = result?.plugins.find(plugin => plugin.id === editId);
    if (editing) notice({ tone: "success", text: `插件「${editing.name}」配置已保存` });
  });
  const closeConfig = useStableEvent(() => {
    setEditId(null);
    if (!configurationSaved.current) void refresh();
    configurationSaved.current = false;
  });

  return { result, loading, busy, error, known, searchQuery, setSearchQuery,
    filteredPlugins: filterPlugins(result?.plugins ?? [], searchQuery), blocked: !active || busy || !known || loading,
    refresh, changeEnabled, restartPlugin, requestUninstall, confirm, confirmOperation,
    cancelConfirmation: () => { if (!pending.current) setConfirm(null); }, removeData, setRemoveData,
    importOpen, importError, preview, importStep, importFileName, importResult, openImport, closeImport, clearPreview,
    selectPackage, inspectPath, droppedFiles, confirmImport, retryImport, canRetryImport: !!(preview || retrySource.current),
    upgrading: preview ? result?.plugins.find(plugin => plugin.id === preview.manifest.id) : undefined,
    openLogs, openDirectory, clearLogsPlugin, clearLogsError, requestClearLogs, clearLogs,
    cancelClearLogs: () => { if (!pending.current) setClearLogsPlugin(null); },
    editing: result?.plugins.find(plugin => plugin.id === editId), openConfig, closeConfig, configChanged };
}
