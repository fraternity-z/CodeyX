import { invoke } from "../../api";
import type { remoteStartOptions } from "./state";
import type { Pairing, RemoteStatus } from "./types";

export const remoteControlRequests = {
  status: () => invoke<RemoteStatus>("remote_control_status"),
  start: (options: ReturnType<typeof remoteStartOptions>) => invoke<RemoteStatus>("start_remote_control", options),
  stop: () => invoke<void>("stop_remote_control"),
  pair: (url: string) => invoke<Pairing>("pair_remote_control", { url }),
  revoke: (id: string) => invoke<void>("revoke_remote_device", { id }),
};
