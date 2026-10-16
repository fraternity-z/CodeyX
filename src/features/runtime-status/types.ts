import type { RuntimeStatus } from "../../App.types";

export type StatusPollTask = {
  deadline: number;
  delayIndex: number;
  delays: readonly number[];
  errors: number;
  kind: "injection" | "restart";
  nextAt: number;
  pending: (next: RuntimeStatus) => boolean;
  refreshesInjectionStatus: boolean;
  onExhausted?: () => void;
};

export type StatusPollScheduler = {
  add: (task: StatusPollTask) => void;
  clear: () => void;
  remove: (task: StatusPollTask) => void;
};

export type StatusPollClock = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (timer: number) => void;
};
