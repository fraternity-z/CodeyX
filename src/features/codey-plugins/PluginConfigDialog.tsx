import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "../../components/ui";
import {
  isEditableConfigArray,
  type PluginConfigEntry,
} from "../../pluginConfigDocument";
import { tokenError, valueToken } from "./state";
import type { PluginConfigOptions } from "./types";
import { usePluginConfigController } from "./usePluginConfigController";

type Props = PluginConfigOptions & { container?: HTMLElement | null };

export function PluginConfigDialog(props: Props) {
  return <ConfigFileEditor key={JSON.stringify([props.plugin.id, props.plugin.version])} {...props} />;
}

function ConfigFileEditor(props: Props) {
  const { plugin, container } = props;
  const { file, document, edits, loading, saving, error, discard, request, confirmDiscard,
    cancelDiscard, edit, save, canSave, isSaving } = usePluginConfigController(props);

  function renderEntry(entry: PluginConfigEntry, last: boolean) {
    const value = edits.get(entry.id) ?? valueToken(entry);
    const validation = edits.has(entry.id) ? tokenError(entry, value) : undefined;
    const fieldId = `plugin-config-value-${encodeURIComponent(entry.id)}`;
    const commentId = `${fieldId}-comment`, errorId = `${fieldId}-error`;
    const composite = entry.kind === "object" || (entry.kind === "array" && !isEditableConfigArray(entry));
    const key = typeof entry.path[entry.path.length - 1] === "string" ? `${JSON.stringify(entry.key)}: ` : "";
    const open = entry.kind === "array" ? "[" : "{";
    const close = entry.kind === "array" ? "]" : "}";
    return <div key={entry.id} className="min-w-0">
      {entry.comment && <p id={commentId} className="mb-0 mt-2 whitespace-pre-wrap break-words font-sans text-[11px] font-normal leading-4 text-zinc-500 dark:text-zinc-400" style={{ userSelect: "none", WebkitUserSelect: "none" }}>{entry.comment}</p>}
      <div className="flex min-w-0 items-baseline leading-7">
        {key && <label htmlFor={composite ? undefined : fieldId} className="shrink-0 whitespace-pre">{key}</label>}
        {composite ? <span>{open}{!entry.children.length && `${close}${last ? "" : ","}`}</span> : <>
          <input id={fieldId} aria-label={entry.path.map(String).join(".")} aria-describedby={[entry.comment ? commentId : "", validation ? errorId : ""].filter(Boolean).join(" ") || undefined} aria-invalid={!!validation}
            value={value} disabled={saving} type="text" spellCheck={false} autoCapitalize="off" autoCorrect="off"
            className="min-w-[3ch] max-w-full rounded-sm border-0 bg-muted/30 px-1 py-0 font-mono text-sm leading-7 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
            style={{ width: `${Math.max(3, value.length + 1)}ch` }} onChange={event => edit(entry, event.target.value)} />
          {!last && <span>,</span>}
        </>}
      </div>
      {composite && !!entry.children.length && <><div className="min-w-0 pl-4 sm:pl-6">{entry.children.map((child, index) => renderEntry(child, index === entry.children.length - 1))}</div><div className="leading-7">{close}{!last && ","}</div></>}
      {validation && <p id={errorId} role="alert" className="m-0 break-words font-sans text-xs text-red-600 dark:text-red-400">{validation}</p>}
    </div>;
  }

  return (
    <Drawer open={props.active !== false} onOpenChange={open => { if (!open) request("close"); }}>
      <DrawerContent
        container={container}
        placement="right"
        className="w-[75%] min-w-[380px] max-w-full h-full border-l border-border"
        onEscapeKeyDown={event => { if (isSaving()) event.preventDefault(); }}
      >
        <div className="contents" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } }}>
          <DrawerHeader>
            <DrawerTitle>{plugin.name} · 配置</DrawerTitle>
            <DrawerDescription>
              按 JSON 格式修改值：字符串带双引号，数字和 true / false 不加引号。数值、文本等值数组可直接增删项；含对象的数组逐项修改字段值。字段名和说明只读。保存后重新启用插件生效。
            </DrawerDescription>
          </DrawerHeader>

          {error && <p role="alert" className="mx-6 mt-3 mb-0 shrink-0 break-words text-xs text-red-600 dark:text-red-400">{error}</p>}

          {discard && (
            <section role="alert" className="mx-6 mt-3 grid shrink-0 gap-2 rounded-lg border border-amber-300 p-3 text-xs">
              <p className="m-0">{discard === "close" ? "配置尚未保存，放弃修改？" : "重新加载将丢弃尚未保存的修改，是否继续？"}</p>
              <div className="flex gap-2">
                <Button size="xs" variant="destructive" disabled={saving} onClick={confirmDiscard}>放弃修改</Button>
                <Button size="xs" variant="outline" disabled={saving} onClick={cancelDiscard}>继续编辑</Button>
              </div>
            </section>
          )}

          <DrawerBody aria-busy={loading || saving} className="mt-2 space-y-3">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="font-medium text-foreground shrink-0">config.json</span>
              <p className="m-0 select-text truncate font-mono text-[11px] text-muted-foreground" title={file?.path ?? plugin.configPath}>
                {file?.path ?? plugin.configPath}
              </p>
            </div>

            {loading ? (
              <p role="status" className="m-0 text-sm text-muted-foreground">正在读取配置文件…</p>
            ) : document && (
              <div
                aria-label="JSON 配置编辑器"
                className="overflow-x-auto rounded-md border border-input bg-background p-3 font-mono text-sm"
              >
                <div className="leading-7">{"{"}</div>
                <div className="min-w-0 pl-4 sm:pl-6">
                  {document.entries.map((entry, index) => renderEntry(entry, index === document.entries.length - 1))}
                </div>
                <div className="leading-7">{"}"}</div>
              </div>
            )}
          </DrawerBody>

          <DrawerFooter className="gap-2">
            <Button size="sm" variant="outline" disabled={saving || loading} onClick={() => request("reload")}>
              {file ? "重新加载" : "重试读取"}
            </Button>
            <Button
              size="sm"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存配置"}
            </Button>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
