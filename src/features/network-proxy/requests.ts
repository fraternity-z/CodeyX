import { invoke } from "../../api";
import type { CredentialUpdate, NetworkProxyConfig, PoolSnapshot, ProbeSnapshot } from "./types";

export const networkProxyRequests = {
  load: () => invoke<PoolSnapshot>("network_proxy_get"),
  save: (settingsRevision: number, config: NetworkProxyConfig, credentials: CredentialUpdate[] = []) =>
    invoke<PoolSnapshot>("network_proxy_save", { settingsRevision, config, credentials }),
  test: (nodeId: string) => invoke<ProbeSnapshot>("network_proxy_test", { nodeId }),
};
