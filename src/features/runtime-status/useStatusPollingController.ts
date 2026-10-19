import { useEffect, useRef } from "react";
import type { RuntimeStatus } from "../../App.types";
import { createStatusPollTask, hasPendingBuiltinInjection, hasPendingConfigApply, INJECTION_PROBE_DELAYS_MS,
  INJECTION_PROBE_MAX_DURATION_MS, STATUS_POLL_MAX_CONSECUTIVE_ERRORS, STATUS_POLL_MAX_DURATION_MS } from "./state";
import type { StatusPollClock, StatusPollScheduler, StatusPollTask } from "./types";

type Options = {
  active: boolean;
  revision: number;
  status: RuntimeStatus;
  restartStatusError: string | null;
  setRestartStatusError: (error: string | null) => void;
  requestRuntimeStatus: (refreshInjectionStatus: boolean) => Promise<RuntimeStatus>;
};

export function useStatusPollingController({ active, revision, status, restartStatusError, setRestartStatusError, requestRuntimeStatus }: Options) {
  const schedulerRef = useRef<StatusPollScheduler | null>(null);
  if (schedulerRef.current === null) schedulerRef.current = createStatusPollScheduler(requestRuntimeStatus);
  const scheduler = schedulerRef.current;
  const builtinInjectionProbePending = hasPendingBuiltinInjection(status);
  const configApplyPending = hasPendingConfigApply(status);

  useEffect(() => () => scheduler.clear(), [active, revision, scheduler]);
  useEffect(() => {
    if (!active || !builtinInjectionProbePending) return;
    const task = createStatusPollTask({
      kind: "injection", delays: INJECTION_PROBE_DELAYS_MS, pending: hasPendingBuiltinInjection,
      refreshesInjectionStatus: true,
    }, INJECTION_PROBE_MAX_DURATION_MS, Date.now());
    scheduler.add(task);
    return () => scheduler.remove(task);
  }, [active, revision, builtinInjectionProbePending, scheduler]);

  useEffect(() => {
    if (!active || !status.restartInProgress || restartStatusError) return;
    const task = createStatusPollTask({
      kind: "restart", delays: [500], pending: (next) => Boolean(next.restartInProgress),
      refreshesInjectionStatus: false,
      onExhausted: () => setRestartStatusError("暂时无法确认 Codex 是否重启完成，请点击重新查询状态"),
    }, STATUS_POLL_MAX_DURATION_MS, Date.now());
    scheduler.add(task);
    return () => scheduler.remove(task);
  }, [active, revision, status.restartInProgress, restartStatusError, scheduler]);

  useEffect(() => {
    if (!active || !configApplyPending || !status.configApply || restartStatusError) return;
    const settingsRevision = status.configApply.settingsRevision;
    const task = createStatusPollTask({
      kind: "config", delays: [500, 1_000, 2_000],
      pending: next => !next.configApply || next.configApply.settingsRevision < settingsRevision || hasPendingConfigApply(next),
      refreshesInjectionStatus: false,
      onExhausted: () => setRestartStatusError("配置已保存，暂时无法确认后台应用结果，请重新查询状态"),
    }, STATUS_POLL_MAX_DURATION_MS, Date.now());
    scheduler.add(task);
    return () => scheduler.remove(task);
  }, [active, revision, configApplyPending, status.configApply?.settingsRevision, restartStatusError, scheduler]);

  return scheduler;
}

const browserStatusPollClock: StatusPollClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (timer) => window.clearTimeout(timer),
};

export function createStatusPollScheduler(
  requestRuntimeStatus: (
    refreshesInjectionStatus: boolean,
  ) => Promise<RuntimeStatus>,
  clock: StatusPollClock = browserStatusPollClock,
): StatusPollScheduler {
  const tasks = new Map<StatusPollTask["kind"], StatusPollTask>();
  let timer = 0;
  let requestInProgress = false;
  let generation = 0;

  const schedule = () => {
    if (requestInProgress) return;
    clock.clearTimeout(timer);
    timer = 0;
    if (tasks.size === 0) return;
    const nextAt = Math.min(...[...tasks.values()].map((task) => task.nextAt));
    timer = clock.setTimeout(() => {
      timer = 0;
      void poll();
    }, Math.max(0, nextAt - clock.now()));
  };

  const poll = async () => {
    if (requestInProgress || tasks.size === 0) return;
    const requestStartedAt = clock.now();
    const dueTasks = [...tasks.values()].filter(
      (task) => task.nextAt <= requestStartedAt,
    );
    if (dueTasks.length === 0) {
      schedule();
      return;
    }

    requestInProgress = true;
    const requestGeneration = generation;
    try {
      const next = await requestRuntimeStatus(
        dueTasks.some((task) => task.refreshesInjectionStatus),
      );
      if (requestGeneration !== generation) return;
      const completedAt = clock.now();
      for (const task of dueTasks) {
        if (tasks.get(task.kind) !== task) continue;
        task.errors = 0;
        task.delayIndex = Math.min(
          task.delayIndex + 1,
          task.delays.length - 1,
        );
        const pending = task.pending(next);
        if (completedAt >= task.deadline || !pending) {
          tasks.delete(task.kind);
          if (pending) task.onExhausted?.();
          continue;
        }
        task.nextAt =
          completedAt +
          (task.kind === "restart" ? 500 : task.delays[task.delayIndex]);
      }
    } catch {
      if (requestGeneration !== generation) return;
      const failedAt = clock.now();
      for (const task of dueTasks) {
        if (tasks.get(task.kind) !== task) continue;
        task.errors += 1;
        task.delayIndex = Math.min(
          task.delayIndex + 1,
          task.delays.length - 1,
        );
        if (
          failedAt >= task.deadline ||
          task.errors >= STATUS_POLL_MAX_CONSECUTIVE_ERRORS
        ) {
          tasks.delete(task.kind);
          task.onExhausted?.();
          continue;
        }
        task.nextAt =
          failedAt +
          (task.kind === "restart"
            ? Math.min(500 * 2 ** task.errors, 5_000)
            : task.delays[task.delayIndex]);
      }
    } finally {
      if (requestGeneration === generation) {
        requestInProgress = false;
        schedule();
      }
    }
  };

  return {
    add(task) {
      tasks.set(task.kind, task);
      schedule();
    },
    clear() {
      generation++;
      requestInProgress = false;
      tasks.clear();
      clock.clearTimeout(timer);
      timer = 0;
    },
    remove(task) {
      if (tasks.get(task.kind) === task) {
        tasks.delete(task.kind);
        schedule();
      }
    },
  };
}
