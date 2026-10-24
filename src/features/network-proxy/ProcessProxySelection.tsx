import { Button, Switch } from "../../components/ui";
import { ProxySelectionField } from "./ProxySelectionField";
import type { useNetworkProxyController } from "./useNetworkProxyController";

type Controller = ReturnType<typeof useNetworkProxyController>;

export function ProcessProxySelection({ controller: c }: { controller: Controller }) {
  if (c.remote) return null;
  const enabled = c.processDraft?.enabled ?? c.processSelection.kind !== "legacy";
  return <div className="proxy-pool" aria-label="Codex 启动出口配置">
    <div className="proxy-pool-heading"><h3 id="launch-proxy-title" className="settings-section-heading">Codex 进程代理</h3>
      <Switch size="sm" label="使用代理池" aria-label="Codex 进程代理使用代理池" checked={enabled}
        disabled={c.processDraft ? c.draftDisabled : c.disabled || c.editing || (!c.launchProxyPoolSupported && !enabled)}
        onCheckedChange={value => c.processDraft ? c.changeProcessEnabled(value) : c.openProcess(value)} /></div>
    <p className="proxy-help">{enabled ? "节点故障时停止连接，不回退手动地址；" : "关闭时沿用手动地址或原有网络环境；"}保存后重启 Codex 生效。</p>
    {enabled && c.processProblem && <p className="text-danger text-xs" role="alert">{c.processProblem}</p>}
    {!c.launchProxyPoolSupported && c.ready && <p className="proxy-help">当前宿主暂不支持从代理池启动 Codex，可继续使用手动启动地址。</p>}
    {c.processDraft ? <form className="proxy-editor" aria-label="Codex 启动出口编辑" onSubmit={event => { event.preventDefault(); void c.saveProcess(); }}>
      {enabled ? <fieldset disabled={c.draftDisabled} className="proxy-editor-grid"><ProxySelectionField label="Codex 启动出口"
        selection={c.processDraft.selection} pool={c.pool} onChange={c.changeProcess} />
        {(c.trafficCaptureSupported || c.processDraft.originalCapture) && <label className="proxy-check proxy-editor-wide"><input type="checkbox" checked={Boolean(c.processDraft.capture)}
          disabled={c.processDraft.selection.kind === "legacy" || (!c.trafficCaptureSupported && !c.processDraft.capture)}
          onChange={event => c.changeProcessCapture(event.target.checked)} />启用实验性 TCP 流量接管</label>}
      </fieldset> : <p className="proxy-help">保存后恢复手动地址或原有网络环境；未配置手动地址时可能直连。</p>}
      {c.processDraft.capture && <p className="proxy-help" role="note">启用时请求管理员权限并加载接管组件，仅绑定本次启动的 Codex 和子进程。UDP/QUIC 会阻断，系统 DNS 不在接管范围；异常退出的防泄漏能力尚未完成实测。组件启动失败时停止启动，不回退直连。</p>}
      {c.processDraft.capture && !c.trafficCaptureAvailable && <p className="proxy-help" role="status">尚未找到接管组件。请先将验证包中的服务及 WinDivert 文件放到 CodeyX 程序目录；缺失时无法启动接管。</p>}
      {c.processDraftError && <p className="proxy-help" role="alert">{c.processDraftError}</p>}
      <div className="proxy-actions"><Button size="xs" type="submit" disabled={c.disabled || Boolean(c.processDraftError)} loading={c.busy === "save-process"}>保存启动出口</Button>
        <Button size="xs" variant="light" disabled={c.busy !== null} onClick={c.cancelProcess}>取消启动出口编辑</Button></div>
    </form> : enabled && <div className="proxy-actions"><span>{c.processLabel}</span><Button size="xs" variant="light" disabled={c.disabled || c.editing} onClick={() => c.openProcess()}>更换进程代理节点</Button></div>}
  </div>;
}
