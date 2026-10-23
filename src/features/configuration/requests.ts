import { invoke } from "../../api";
import type { Config, ConfigSaveResult } from "../../App.types";
import type { ConfigLoadResult } from "./types";

export const configurationRequests = {
  load: async (): Promise<ConfigLoadResult> => {
    const result = await invoke<ConfigLoadResult>("load_codey_config");
    return { ...result, config: { ...result.config, codeyUpdateDownloadSource: result.config.codeyUpdateDownloadSource ?? "github" } };
  },
  save: (config: Config) => invoke<ConfigSaveResult>("save_codey_config", { config }),
};
