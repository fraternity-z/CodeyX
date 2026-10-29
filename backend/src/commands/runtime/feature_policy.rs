use serde_json::{Value, json};

use crate::config::CodeyConfig;
use crate::crashpad_pending_guard::CrashpadPendingStatsSnapshot;
use crate::trace_log_guard::TraceLogGuardStatsSnapshot;

pub(super) fn status_value(
    configured: &CodeyConfig,
    applied: Option<&CodeyConfig>,
    trace_watcher_active: bool,
    trace: &TraceLogGuardStatsSnapshot,
    crashpad: &CrashpadPendingStatsSnapshot,
) -> Value {
    json!({
        "configured": {
            "gpuLaunchMode": configured.gpu_launch_mode,
            "slimCodexPet": configured.slim_codex_pet,
            "disableTraceLogWrites": configured.disable_trace_log_writes,
            "protectCrashpadPending": configured.protect_crashpad_pending,
            "hideFullAccessWarning": configured.hide_full_access_warning,
        },
        "applied": applied.map(|applied| json!({
            "gpuLaunchMode": applied.gpu_launch_mode,
            "slimCodexPet": applied.slim_codex_pet,
        })),
        "traceWatcherActive": applied.is_some() && trace_watcher_active,
        "traceProtection": trace,
        "crashpadProtection": crashpad,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{GpuLaunchMode, ProviderProfile};

    #[test]
    fn policy_status_separates_saved_values_from_the_running_launch_baseline() {
        let applied = CodeyConfig {
            gpu_launch_mode: GpuLaunchMode::Off,
            slim_codex_pet: false,
            ..CodeyConfig::default()
        };
        let mut configured = applied.clone();
        configured.gpu_launch_mode = GpuLaunchMode::DisableGpuRasterization;
        configured.slim_codex_pet = true;
        configured.disable_trace_log_writes = true;
        configured.protect_crashpad_pending = false;
        configured.hide_full_access_warning = true;
        let mut private_route = ProviderProfile::new("private-route-name");
        private_route.api_key = "private-route-api-key".into();
        configured.profiles.push(private_route);

        let trace = TraceLogGuardStatsSnapshot {
            captured_at: 123,
            last_successful_at: Some(123),
            databases_found: 2,
            log_tables_found: 1,
            ..Default::default()
        };
        let crashpad = CrashpadPendingStatsSnapshot::idle(false);
        let value = status_value(&configured, Some(&applied), true, &trace, &crashpad);

        assert_eq!(
            value,
            json!({
                "configured": {
                    "gpuLaunchMode": "disableGpuRasterization",
                    "slimCodexPet": true,
                    "disableTraceLogWrites": true,
                    "protectCrashpadPending": false,
                    "hideFullAccessWarning": true,
                },
                "applied": {"gpuLaunchMode": "off", "slimCodexPet": false},
                "traceWatcherActive": true,
                "traceProtection": serde_json::to_value(&trace).unwrap(),
                "crashpadProtection": serde_json::to_value(&crashpad).unwrap(),
            })
        );
        let serialized = value.to_string();
        assert!(!serialized.contains("private-route-name"));
        assert!(!serialized.contains("private-route-api-key"));
    }

    #[test]
    fn stopped_policy_status_does_not_claim_a_running_watcher_or_discard_failures() {
        let configured = CodeyConfig::default();
        let trace = TraceLogGuardStatsSnapshot {
            captured_at: 456,
            last_successful_at: Some(123),
            errors: vec!["Trace check failed".into()],
            ..Default::default()
        };
        let crashpad = CrashpadPendingStatsSnapshot {
            captured_at: 456,
            last_successful_at: Some(123),
            over_limit: true,
            errors: vec!["Crashpad cleanup failed".into()],
            ..CrashpadPendingStatsSnapshot::idle(true)
        };
        let value = status_value(&configured, None, true, &trace, &crashpad);

        assert!(value["applied"].is_null());
        assert_eq!(value["traceWatcherActive"], false);
        assert_eq!(value["traceProtection"]["lastSuccessfulAt"], 123);
        assert_eq!(
            value["traceProtection"]["errors"],
            json!(["Trace check failed"])
        );
        assert_eq!(value["crashpadProtection"]["overLimit"], true);
        assert_eq!(value["crashpadProtection"]["lastSuccessfulAt"], 123);
        assert_eq!(
            value["crashpadProtection"]["errors"],
            json!(["Crashpad cleanup failed"])
        );
    }
}
