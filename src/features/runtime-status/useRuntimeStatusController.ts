import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeStatus } from "../../App.types";
import { runtimeStatusRequests } from "./requests";
import { reconcileRuntimeStatus, SETTINGS_OPENED_EVENT } from "./state";
import { useStatusPollingController } from "./useStatusPollingController";

const INJECTION_STATUS_CHANGED_EVENT = "codey-injection-status-changed";

type UseRuntimeStatusOptions = {
  active: boolean;
  embedded: boolean;
};

type RuntimeStatusFlight = {
  refreshesInjectionStatus: boolean;
  promise: Promise<RuntimeStatus>;
};

export function useRuntimeStatusController({
  active,
  embedded,
}: UseRuntimeStatusOptions) {
  const [status, setStatus] = useState<RuntimeStatus>({ running: false });
  const [restartStatusError, setRestartStatusError] = useState<string | null>(null);
  const runtimeStatusFlightRef = useRef<RuntimeStatusFlight | null>(null);
  const settingsOpenRefreshRequestedRef = useRef(false);
  const mountedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const requestTimersRef = useRef(new Set<number>());
  const statusRef = useRef(status);
  statusRef.current = status;
  const activeRef = useRef(active);
  activeRef.current = active;

  const invalidateReads = useCallback(() => {
    requestGenerationRef.current += 1;
    runtimeStatusFlightRef.current = null;
    for (const timer of requestTimersRef.current) window.clearTimeout(timer);
    requestTimersRef.current.clear();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; invalidateReads(); };
  }, [invalidateReads]);
  useEffect(() => () => {
    settingsOpenRefreshRequestedRef.current = false;
    invalidateReads();
  }, [active, invalidateReads]);

  const requestRuntimeStatus = useCallback(
    (shouldRefreshInjectionStatus: boolean): Promise<RuntimeStatus> => {
      if (!mountedRef.current || !activeRef.current) return Promise.resolve(statusRef.current);
      const requestCanCommit = (requestGeneration: number) =>
        mountedRef.current &&
        activeRef.current &&
        requestGenerationRef.current === requestGeneration;
      const startRequest = (
        refreshesInjectionStatus: boolean,
        requestGeneration = requestGenerationRef.current,
      ) => {
        const request = new Promise<RuntimeStatus>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            requestTimersRef.current.delete(timer);
            reject(new Error("运行状态查询超时，请重新查询"));
          }, 10_000);
          requestTimersRef.current.add(timer);
          const clearTimer = () => {
            window.clearTimeout(timer);
            requestTimersRef.current.delete(timer);
          };
          void runtimeStatusRequests.read(refreshesInjectionStatus).then(
            (next) => { clearTimer(); resolve(next); },
            (error) => { clearTimer(); reject(error); },
          );
        });
        return request.then((next) => {
          if (requestCanCommit(requestGeneration)) {
            setStatus((current) => reconcileRuntimeStatus(current, next));
            setRestartStatusError(null);
          }
          return next;
        });
      };

      const currentFlight = runtimeStatusFlightRef.current;
      if (currentFlight) {
        if (
          !shouldRefreshInjectionStatus ||
          currentFlight.refreshesInjectionStatus
        ) {
          return currentFlight.promise;
        }

        const queuedGeneration = requestGenerationRef.current;
        const startQueuedRefresh = () =>
          requestCanCommit(queuedGeneration)
            ? startRequest(true, queuedGeneration)
            : null;
        const queuedFlight: RuntimeStatusFlight = {
          refreshesInjectionStatus: true,
          promise: currentFlight.promise.then(
            (next) => startQueuedRefresh() ?? next,
            (error) => startQueuedRefresh() ?? Promise.reject(error),
          ),
        };
        runtimeStatusFlightRef.current = queuedFlight;
        const clearQueuedFlight = () => {
          if (runtimeStatusFlightRef.current === queuedFlight) {
            runtimeStatusFlightRef.current = null;
          }
        };
        void queuedFlight.promise.then(clearQueuedFlight, clearQueuedFlight);
        return queuedFlight.promise;
      }

      const flight: RuntimeStatusFlight = {
        refreshesInjectionStatus: shouldRefreshInjectionStatus,
        promise: startRequest(shouldRefreshInjectionStatus),
      };
      runtimeStatusFlightRef.current = flight;
      const clearFlight = () => {
        if (runtimeStatusFlightRef.current === flight) {
          runtimeStatusFlightRef.current = null;
        }
      };
      void flight.promise.then(clearFlight, clearFlight);
      return flight.promise;
    },
    [],
  );

  const refreshStatus = useCallback(
    () => requestRuntimeStatus(false),
    [requestRuntimeStatus],
  );

  const refreshInjectionStatus = useCallback(
    () => requestRuntimeStatus(true),
    [requestRuntimeStatus],
  );

  const statusPollScheduler = useStatusPollingController({
    active, status, restartStatusError, setRestartStatusError, requestRuntimeStatus,
    revision: requestGenerationRef.current,
  });

  const markRestartInProgress = useCallback(() => {
    if (!mountedRef.current || !activeRef.current) return;
    // 修复或重启开始后，旧请求及其排队中的探测均失去采纳资格。
    invalidateReads();
    statusPollScheduler.clear();
    setRestartStatusError(null);
    setStatus((current) => ({ ...current, restartInProgress: true }));
  }, [invalidateReads, statusPollScheduler]);

  const refreshInBackground = useCallback(() => {
    if (!mountedRef.current || !activeRef.current) return;
    const generation = requestGenerationRef.current;
    settingsOpenRefreshRequestedRef.current = true;
    void refreshInjectionStatus().catch(() => {
      if (mountedRef.current && activeRef.current && generation === requestGenerationRef.current) {
        console.error("Codey 运行状态刷新失败，请重新查询");
      }
    });
  }, [refreshInjectionStatus]);

  useEffect(() => {
    if (active) refreshInBackground();
  }, [active, refreshInBackground]);

  const refreshStatusForLoad = useCallback(async (): Promise<RuntimeStatus | null> => {
    if (!mountedRef.current || !activeRef.current) return null;
    const generation = requestGenerationRef.current;
    const current = () => mountedRef.current && activeRef.current && generation === requestGenerationRef.current;
    const shouldRefreshInjectionStatus =
      !embedded || !settingsOpenRefreshRequestedRef.current;
    try {
      const next = await (shouldRefreshInjectionStatus ? refreshInjectionStatus() : refreshStatus());
      return current() ? next : null;
    } catch (error) {
      if (current()) throw error;
      return null;
    }
  }, [embedded, refreshInjectionStatus, refreshStatus]);

  useEffect(() => {
    const handleInjectionStatusChanged = refreshInBackground;
    window.addEventListener(
      INJECTION_STATUS_CHANGED_EVENT,
      handleInjectionStatusChanged,
    );
    return () => {
      window.removeEventListener(
        INJECTION_STATUS_CHANGED_EVENT,
        handleInjectionStatusChanged,
      );
    };
  }, [refreshInBackground]);

  useEffect(() => {
    // overlay 在 React 提交 active 前派发打开事件；此时由激活 effect 负责刷新。
    const handleSettingsOpened = refreshInBackground;
    window.addEventListener(SETTINGS_OPENED_EVENT, handleSettingsOpened);
    return () => {
      window.removeEventListener(SETTINGS_OPENED_EVENT, handleSettingsOpened);
    };
  }, [refreshInBackground]);

  return {
    status,
    setStatus,
    markRestartInProgress,
    refreshStatus,
    refreshStatusForLoad,
    restartStatusError,
    setRestartStatusError,
  };
}
