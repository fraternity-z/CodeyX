import { IconNetwork, IconX } from "@tabler/icons-react";
import type { Config, ConfigSaveResult } from "../../App.types";
import { Badge, Input } from "../../components/ui";
import { SettingsPageHeader } from "../../SettingsPageHeader";
import { useNetworkProxyController } from "./useNetworkProxyController";
import { ProxyPool } from "./ProxyPool";
import { ProxyChains } from "./ProxyChains";
import { UpstreamSelection } from "./UpstreamSelection";
import { ProcessProxySelection } from "./ProcessProxySelection";
import { ProxyPolicies } from "./ProxyPolicies";
import "./network-proxy.css";

type Props = {
  active: boolean;
  config: Config;
  isBusy: boolean;
  onConfigChange: (config: Config) => void;
  onSaved: (result: ConfigSaveResult) => boolean;
};

export function NetworkProxyPage(props: Props) {
  const controller = useNetworkProxyController({ ...props, remote: window.__codeyRemoteClient === true });
  const { launchProxy, launchProxyError, changeLaunchProxy } = controller;
  return (
    <section className="secondary-section" aria-labelledby="network-proxy-title">
      <SettingsPageHeader id="network-proxy-title" title="网络代理" icon={<IconNetwork size={15} />}
        description="管理 Codex 的网络接入和出口，保留其他应用的网络设置。" />
      <section className="secondary-section launch-proxy-section" aria-labelledby="launch-proxy-title">
        <div className="feature-policy-heading">
          <div className="flex items-center gap-2">
            <h3 id="launch-proxy-title" className="settings-section-heading">Codex 启动代理</h3>
            <Badge variant="secondary">{controller.pool.processCapture ? "下次启动接管" : "兼容接入"}</Badge>
          </div>
          <p>为客户端与支持代理设置的子进程选择出口；保存后，重启 Codex 后生效。</p>
        </div>
        <ProcessProxySelection controller={controller} />
        <div className={`feature-card launch-proxy-card ${launchProxy.trim() ? "active" : ""}`}>
          <div className="feature-card-body">
            <Input id="codex-launch-proxy-input" aria-label="Codex 启动代理"
              aria-invalid={Boolean(launchProxyError)}
              aria-describedby={launchProxyError ? "codex-launch-proxy-error" : "codex-launch-proxy-description"}
              value={launchProxy} disabled={props.isBusy} placeholder="例如 http://127.0.0.1:7890"
              onChange={event => changeLaunchProxy(event.target.value)}
              rightSection={launchProxy ? <button type="button" disabled={props.isBusy}
                className="flex h-5 w-5 items-center justify-center" aria-label="清空代理设置"
                onClick={() => changeLaunchProxy("")}><IconX size={12} aria-hidden="true" /></button> : undefined} />
            {launchProxyError && <small id="codex-launch-proxy-error" role="alert" className="text-danger">{launchProxyError}</small>}
            <small id="codex-launch-proxy-description">
              手动地址支持 HTTP、HTTPS、SOCKS5 和 socks5h，不支持用户名密码；需要认证时请从代理池选择。SOCKS 地址必须指定端口。
            </small>
            {controller.processSelection.kind !== "legacy" && <small>已选择代理池出口，此手动地址保留备用，解除代理池选择并重启后才会使用。</small>}
            <small>未选择代理池且手动地址留空时，沿用原有网络环境；本地模型路由、额度查询使用各线路的上游设置。</small>
          </div>
        </div>
        <p className="m-0 text-xs text-muted" role="note">
          {controller.pool.processCapture
            ? "已为下次启动选择实验性 TCP 接管；系统 DNS 与异常退出防泄漏仍有边界，保存设置不代表接管正在运行。"
            : "当前为兼容接入，未启用强制进程隔离。忽略代理设置的程序、DNS 或 UDP 请求可能不经过此代理。"}
        </p>
      </section>
      <ProxyPool controller={controller} />
      <ProxyChains controller={controller} />
      <ProxyPolicies controller={controller} />
      <UpstreamSelection controller={controller} />
    </section>
  );
}
