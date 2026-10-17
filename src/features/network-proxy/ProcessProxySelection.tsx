import { Badge, Button } from "../../components/ui";
import { ProxySelectionField } from "./ProxySelectionField";
import type { useNetworkProxyController } from "./useNetworkProxyController";

type Controller = ReturnType<typeof useNetworkProxyController>;

export function ProcessProxySelection({ controller: c }: { controller: Controller }) {
  if (c.remote) return null;
  return <div className="proxy-node" aria-label="Codex 启动出口配置">
    <div className="proxy-actions"><strong>{c.processLabel}</strong><Badge variant="secondary">下次启动设置</Badge></div>
    <p className="proxy-help">选择代理池后，Codex 客户端及支持代理的子进程通过本机认证入口连接所选出口。固定选择故障时阻断，策略选择按显式规则处理，不改用下方手动地址。</p>
    <p className="proxy-help">本地模型路由和账号请求仍按下方各线路的上游出口转发；外部浏览器保留自己的网络设置。</p>
    {c.processProblem && <p className="text-danger text-xs" role="alert">{c.processProblem}</p>}
    {!c.launchProxyPoolSupported && c.ready && <p className="proxy-help">当前宿主暂不支持从代理池启动 Codex，可继续使用手动启动地址。</p>}
    {c.processDraft ? <form className="proxy-editor" aria-label="Codex 启动出口编辑" onSubmit={event => { event.preventDefault(); void c.saveProcess(); }}>
      <fieldset disabled={c.draftDisabled} className="proxy-editor-grid"><ProxySelectionField label="Codex 启动出口"
        legacyLabel="手动启动地址或原有网络环境" selection={c.processDraft.selection} pool={c.pool} onChange={c.changeProcess} /></fieldset>
      {c.processDraft.selection.kind === "legacy" && c.processDraft.original.kind !== "legacy" && <p className="proxy-help" role="note">解除代理池选择后，下次启动恢复下方手动地址或原有网络环境；未配置手动地址时可能直连。</p>}
      {c.processDraftError && <p className="proxy-help" role="alert">{c.processDraftError}</p>}
      <div className="proxy-actions"><Button size="xs" type="submit" disabled={c.disabled || Boolean(c.processDraftError)} loading={c.busy === "save-process"}>保存启动出口</Button>
        <Button size="xs" variant="light" disabled={c.busy !== null} onClick={c.cancelProcess}>取消启动出口编辑</Button></div>
    </form> : <div className="proxy-actions"><Button size="xs" variant="light" disabled={c.disabled || c.editing || (!c.launchProxyPoolSupported && c.processSelection.kind === "legacy")} onClick={c.openProcess}>选择 Codex 启动出口</Button></div>}
  </div>;
}
