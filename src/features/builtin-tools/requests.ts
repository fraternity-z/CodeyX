import { invoke } from "../../api";
import type { BuiltinToolsStatus } from "../../builtinTools";

export const builtinToolsRequests = {
  status: () => invoke<BuiltinToolsStatus>("builtin_tools", { action: "status" }),
  setEnabled: (enabled: boolean) => invoke<BuiltinToolsStatus>("builtin_tools", { action: "set_enabled", enabled }),
};
