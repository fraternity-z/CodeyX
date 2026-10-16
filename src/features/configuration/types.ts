import type { ConfigSaveResult } from "../../App.types";

export type ConfigLoadResult = ConfigSaveResult & {
  startupError?: string;
  configLoadError?: string;
  officialAccountAvailable?: boolean;
};
