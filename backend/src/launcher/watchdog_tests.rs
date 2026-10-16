use super::{
    CDP_WATCHDOG_FAILURE_THRESHOLD, CDP_WATCHDOG_INCONCLUSIVE_LIMIT,
    CDP_WATCHDOG_UNRESPONSIVE_THRESHOLD, InjectionFailureCounters, InjectionHealth,
    watchdog_should_reinject,
};

#[test]
fn cdp_watchdog_requires_consecutive_failures_before_reinjecting() {
    let mut counters = InjectionFailureCounters::default();

    assert!(!watchdog_should_reinject(
        &mut counters,
        InjectionHealth::Unhealthy
    ));
    assert_eq!(counters.unhealthy, 1);
    assert!(!watchdog_should_reinject(
        &mut counters,
        InjectionHealth::Healthy
    ));
    assert_eq!(counters, InjectionFailureCounters::default());
    assert!(!watchdog_should_reinject(
        &mut counters,
        InjectionHealth::Unhealthy
    ));
    assert!(watchdog_should_reinject(
        &mut counters,
        InjectionHealth::Unhealthy
    ));
}

#[test]
fn cdp_watchdog_waits_out_renderer_timeouts_but_not_forever() {
    let mut counters = InjectionFailureCounters::default();

    for _ in 1..CDP_WATCHDOG_INCONCLUSIVE_LIMIT {
        assert!(!watchdog_should_reinject(
            &mut counters,
            InjectionHealth::Inconclusive
        ));
    }
    // A busy renderer is left alone for a while, but a bridge that never
    // round-trips again must still be rebuilt.
    assert!(watchdog_should_reinject(
        &mut counters,
        InjectionHealth::Inconclusive
    ));
}

#[test]
fn cdp_watchdog_rebuilds_an_unresponsive_page_endpoint_sooner_than_a_busy_one() {
    let mut counters = InjectionFailureCounters::default();

    for _ in 1..CDP_WATCHDOG_UNRESPONSIVE_THRESHOLD {
        assert!(!watchdog_should_reinject(
            &mut counters,
            InjectionHealth::Unresponsive
        ));
    }
    assert!(watchdog_should_reinject(
        &mut counters,
        InjectionHealth::Unresponsive
    ));
}

#[test]
fn cdp_watchdog_alternating_failures_cannot_reset_each_others_budget() {
    let mut counters = InjectionFailureCounters::default();

    // A half-dead bridge that alternates shapes must still reach reinjection;
    // sharing one counter let each shape erase the other's progress.
    assert!(!watchdog_should_reinject(
        &mut counters,
        InjectionHealth::Unhealthy
    ));
    assert!(!watchdog_should_reinject(
        &mut counters,
        InjectionHealth::Inconclusive
    ));
    assert!(!watchdog_should_reinject(
        &mut counters,
        InjectionHealth::Unresponsive
    ));
    assert!(watchdog_should_reinject(
        &mut counters,
        InjectionHealth::Unhealthy
    ));
}

#[test]
fn cdp_watchdog_reinjects_as_soon_as_the_bridge_pump_finishes() {
    let mut counters = InjectionFailureCounters::default();

    // The pump already reported that the page can no longer reach the backend;
    // waiting for the next probe verdict would only delay the rebuild.
    assert!(watchdog_should_reinject(
        &mut counters,
        InjectionHealth::BridgeClosed
    ));
    assert_eq!(counters, InjectionFailureCounters::default());
}

#[test]
fn failed_reinjection_keeps_every_budget_one_step_below_its_threshold() {
    let mut counters = InjectionFailureCounters::after_failed_reinjection();

    assert_eq!(counters.unhealthy, CDP_WATCHDOG_FAILURE_THRESHOLD - 1);
    assert_eq!(
        counters.unresponsive,
        CDP_WATCHDOG_UNRESPONSIVE_THRESHOLD - 1
    );
    assert_eq!(counters.inconclusive, CDP_WATCHDOG_INCONCLUSIVE_LIMIT - 1);
    // The next matching failure retries immediately, keeping the watchdog at
    // most one rebuild attempt per interval.
    assert!(watchdog_should_reinject(
        &mut counters,
        InjectionHealth::Unhealthy
    ));
}

#[test]
fn cdp_watchdog_immediately_rediscovers_an_unavailable_target() {
    let mut counters = InjectionFailureCounters {
        unhealthy: 1,
        inconclusive: 3,
        unresponsive: 1,
    };

    assert!(watchdog_should_reinject(
        &mut counters,
        InjectionHealth::TargetUnavailable
    ));
    assert_eq!(counters, InjectionFailureCounters::default());
}
