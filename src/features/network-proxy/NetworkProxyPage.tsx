import { IconNetwork, IconX } from "@tabler/icons-react";
import type { Config } from "../../App.types";
import { Badge, Input } from "../../components/ui";
import { SettingsPageHeader } from "../../SettingsPageHeader";
import { useNetworkProxyController } from "./useNetworkProxyController";

type Props = {
  active: boolean;
  config: Config;
  isBusy: boolean;
  onConfigChange: (config: Config) => void;
};

export function NetworkProxyPage(props: Props) {
  const { launchProxy, changeLaunchProxy } = useNetworkProxyController(props);
  return (
    <section className="secondary-section" aria-labelledby="network-proxy-title">
      <SettingsPageHeader id="network-proxy-title" title="网络代理" icon={<IconNetwork size={15} />}
        description="设置 Codex 启动代理，保存后重启 Codex 生效。" />
      <div className={`feature-card launch-proxy-card ${launchProxy.trim() ? "active" : ""}`}>
        <div className="feature-card-body">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="codex-launch-proxy-input" className="text-[13px] font-semibold text-[var(--codey-text)]">启动代理地址</label>
            <Badge variant={launchProxy.trim() ? "success" : "secondary"}>{launchProxy.trim() ? "已设置" : "未设置"}</Badge>
          </div>
          <Input id="codex-launch-proxy-input" aria-label="Codex 启动代理"
            aria-describedby="codex-launch-proxy-description"
            value={launchProxy} disabled={props.isBusy} placeholder="例如 http://127.0.0.1:7890"
            onChange={event => changeLaunchProxy(event.target.value)}
            rightSection={launchProxy ? <button type="button" disabled={props.isBusy}
              className="flex size-6 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-[var(--codey-surface-hover)] hover:text-[var(--codey-text)] focus-visible:outline-2 focus-visible:outline-[var(--codey-blue)] disabled:cursor-not-allowed disabled:opacity-50" aria-label="清空代理设置"
              onClick={() => changeLaunchProxy("")}><IconX size={12} aria-hidden="true" /></button> : undefined} />
          <small id="codex-launch-proxy-description">
            支持 HTTP、HTTPS、SOCKS5 和 socks5h 地址，不支持用户名密码。留空时沿用原有网络环境。
          </small>
          <small>启动时无法应用代理地址会提示并继续启动；本地模型路由和额度查询仍使用各线路的上游设置。</small>
        </div>
      </div>
    </section>
  );
}
