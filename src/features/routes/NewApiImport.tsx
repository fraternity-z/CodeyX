import { useState } from "react";
import { Button, TextArea } from "../../components/ui";

export function NewApiImport({ disabled, onImport }: {
  disabled: boolean;
  onImport: (text: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  return <div className="route-import-panel grid gap-2">
    <Button variant="secondary" size="sm" disabled={disabled} aria-expanded={open}
      aria-controls="newapi-import-fields" onClick={() => { setOpen(!open); setText(""); setError(""); }}>
      New API 快速导入
    </Button>
    {open && <div id="newapi-import-fields" className="route-field">
      <label htmlFor="newapi-connection-input">New API 连接串</label>
      <TextArea id="newapi-connection-input" aria-label="New API 连接串"
        aria-invalid={Boolean(error)} aria-describedby={error ? "newapi-import-error" : "newapi-import-help"}
        value={text} disabled={disabled} autoComplete="off" spellCheck={false} maxLength={65536}
        placeholder="粘贴 New API 中「复制连接串」的内容"
        onChange={event => { setText(event.target.value); setError(""); }} />
      <small id="newapi-import-help" className="route-field-hint">填入地址和密钥后，可继续检查并保存线路。</small>
      {error && <small id="newapi-import-error" className="text-[var(--codey-red,#d70015)]" role="alert">{error}</small>}
      <Button variant="secondary" size="sm" disabled={disabled || !text.trim()} onClick={() => {
        const message = onImport(text);
        if (message) setError(message);
        else { setText(""); setError(""); setOpen(false); }
      }}>填入线路</Button>
    </div>}
  </div>;
}
