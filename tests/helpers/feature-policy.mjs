export function featurePolicyRuntimeFixture() {
  const capturedAt = 1_793_240_000;
  return {
    running: true,
    traceLogWriteProtectionActive: true,
    crashpadDiskProtectionActive: true,
    featurePolicy: {
      configured: {
        gpuLaunchMode: "off", slimCodexPet: true, disableTraceLogWrites: true,
        protectCrashpadPending: true, hideFullAccessWarning: false,
      },
      applied: { gpuLaunchMode: "off", slimCodexPet: true },
      traceWatcherActive: true,
      traceProtection: {
        pending: false, capturedAt, lastSuccessfulAt: capturedAt,
        databasesFound: 1, logTablesFound: 1, errors: [],
      },
      crashpadProtection: {
        pending: false, capturedAt, lastSuccessfulAt: capturedAt,
        directoriesFound: 1, reportsFound: 2, completeReports: 2, filesFound: 2,
        managedFiles: 2, orphanFiles: 0, unmanagedFiles: 0,
        pendingBytes: 128 * 1024 * 1024, managedBytes: 128 * 1024 * 1024,
        hardLimitBytes: 512 * 1024 * 1024, targetBytes: 384 * 1024 * 1024,
        overLimit: false, protectionEnabled: true, errors: [],
      },
    },
    injectionScripts: [
      { id: "pet-control-shield", status: "effective", detail: "宠物控制精简已启用" },
      { id: "runtime-optimizations", status: "effective", detail: "已抑制：CPU 采样、交互心跳、诊断心跳、宠物自动预热" },
      { id: "security-warning-shield", status: "inactive" },
    ],
  };
}
