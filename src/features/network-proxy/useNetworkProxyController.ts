import type { Config } from "../../App.types";
import { useStableEvent } from "../../useStableEvent";

type Options = {
  active: boolean;
  config: Config;
  isBusy: boolean;
  onConfigChange: (config: Config) => void;
};

export function useNetworkProxyController({ active, config, isBusy, onConfigChange }: Options) {
  const changeLaunchProxy = useStableEvent((value: string) => {
    if (!active || isBusy) return;
    onConfigChange({ ...config, codexLaunchProxy: value });
  });
  return { launchProxy: config.codexLaunchProxy ?? "", changeLaunchProxy };
}
