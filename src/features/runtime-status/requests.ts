import { invoke } from "../../api";
import type { RuntimeStatus } from "../../App.types";

export const runtimeStatusRequests = {
  read: (refreshInjectionStatus: boolean) => invoke<RuntimeStatus>("runtime_status", { refreshInjectionStatus }),
};
