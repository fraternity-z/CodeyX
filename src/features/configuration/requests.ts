import { invoke } from "../../api";
import type { Config, ConfigSaveResult } from "../../App.types";
import type { ConfigLoadResult } from "./types";

export const configurationRequests = {
  load: () => invoke<ConfigLoadResult>("load_codey_config"),
  save: (config: Config) => invoke<ConfigSaveResult>("save_codey_config", { config }),
};
