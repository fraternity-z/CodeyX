import type { RuntimeStatus } from "../../App.types";
import type { StatusPollTask } from "./types";

export const SETTINGS_OPENED_EVENT = "codey-settings-opened";
export const STATUS_POLL_MAX_DURATION_MS = 5 * 60 * 1_000;
export const STATUS_POLL_MAX_CONSECUTIVE_ERRORS = 5;
export const INJECTION_PROBE_DELAYS_MS = [500, 1_000, 2_000, 5_000] as const;
export const INJECTION_PROBE_MAX_DURATION_MS = 60_000;

export function hasPendingBuiltinInjection(status: RuntimeStatus): boolean {
  return status.injectionScripts?.some(
    (script) => script.source === "builtin" && script.status === "executed",
  ) ?? false;
}

export function hasPendingConfigApply(status: RuntimeStatus): boolean {
  return status.configApply?.phase === "pending" || status.configApply?.phase === "applying";
}

export function createStatusPollTask(
  task: Omit<StatusPollTask, "deadline" | "delayIndex" | "errors" | "nextAt">,
  duration: number,
  now: number,
): StatusPollTask {
  return { ...task, deadline: now + duration, delayIndex: 0, errors: 0, nextAt: now + task.delays[0] };
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function reuseEqualValue<Value>(current: Value, next: Value): Value {
  return valuesEqual(current, next) ? current : next;
}

export function reconcileRuntimeStatus(
  current: RuntimeStatus,
  next: RuntimeStatus,
): RuntimeStatus {
  if (valuesEqual(current, next)) return current;

  const reconciled = { ...next };
  if (current.configApply && (!next.configApply || next.configApply.settingsRevision < current.configApply.settingsRevision
    || (next.configApply.settingsRevision === current.configApply.settingsRevision
      && !hasPendingConfigApply(current) && hasPendingConfigApply(next)))) {
    reconciled.configApply = current.configApply;
    reconciled.restartRequired = current.restartRequired;
  }
  if (next.maintenance !== undefined) {
    reconciled.maintenance = reuseEqualValue(
      current.maintenance,
      next.maintenance,
    );
  }
  if (next.injectionScripts !== undefined) {
    reconciled.injectionScripts = reuseEqualValue(
      current.injectionScripts,
      next.injectionScripts,
    );
  }
  return reconciled;
}
