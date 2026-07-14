//! Per-leg relay delivery health.
//!
//! A relay destination ("leg") once died silently for weeks while the
//! process looked perfectly alive — a failing leg only ever produced
//! per-message WARN lines in a noisy log. This module makes per-leg delivery
//! a first-class fact: every attempt is recorded per destination room, and
//! the state (last success age, consecutive failures, totals, last error) is
//! queryable by the periodic reporter and the `!diag` command. A leg
//! crossing the failure threshold is escalated to ERROR immediately by the
//! caller.
//!
//! Legs are pre-registered from the relay plan at startup so a destination
//! that NEVER receives traffic still shows up in every report as
//! `last_success=never` instead of being invisible.

use core::fmt::Write as _;
use core::time::Duration;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// Consecutive send failures after which a leg is considered dead.
pub const DEAD_LEG_THRESHOLD: u32 = 3;

#[derive(Debug, Default, Clone)]
struct LegState {
    last_success: Option<Instant>,
    last_attempt: Option<Instant>,
    consecutive_failures: u32,
    relayed: u64,
    failed: u64,
    last_error: Option<String>,
}

/// A point-in-time report for one relay leg.
#[derive(Debug, Clone)]
pub struct LegReport {
    /// Destination room id.
    pub room: String,
    /// `false` once [`DEAD_LEG_THRESHOLD`] consecutive failures accumulate.
    pub healthy: bool,
    /// Consecutive failures since the last success.
    pub consecutive_failures: u32,
    /// Total successfully relayed messages.
    pub relayed: u64,
    /// Total failed relay attempts.
    pub failed: u64,
    /// Seconds since the last successful relay to this leg, if any.
    pub secs_since_success: Option<u64>,
    /// Seconds since the last attempt (success or failure), if any.
    pub secs_since_attempt: Option<u64>,
    /// The most recent error message, if any.
    pub last_error: Option<String>,
}

impl LegReport {
    /// One-line human summary, used by the reporter and `!diag`.
    #[must_use]
    pub fn summary(&self) -> String {
        let status = if self.healthy { "ok" } else { "DEAD" };
        let last_ok = self.secs_since_success.map_or_else(
            || "never".to_owned(),
            |s| format!("{}m{}s ago", s / 60, s % 60),
        );
        let mut line = format!(
            "{}: {status} relayed={} failed={} last_success={last_ok}",
            self.room, self.relayed, self.failed
        );
        if self.consecutive_failures > 0 {
            let _ = write!(line, " consecutive_failures={}", self.consecutive_failures);
        }
        if let Some(err) = &self.last_error {
            let _ = write!(line, " last_error={err}");
        }
        line
    }
}

/// Shared registry of per-leg relay health. Share via `Arc`.
///
/// Uses a `std::sync::Mutex` (never held across an await) so it is usable
/// from both async tasks and plain OS threads (e.g. the watchdog).
#[derive(Debug, Default)]
pub struct RelayHealth {
    legs: Mutex<HashMap<String, LegState>>,
}

impl RelayHealth {
    /// Create an empty health registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Pre-register a leg so it appears in reports before any traffic.
    pub fn register(&self, room: &str) {
        let mut legs = self
            .legs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        legs.entry(room.to_owned()).or_default();
        drop(legs);
    }

    /// Record a successful relay to `room`. Resets the failure streak.
    pub fn record_success(&self, room: &str) {
        let mut legs = self
            .legs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let leg = legs.entry(room.to_owned()).or_default();
        let now = Instant::now();
        leg.last_success = Some(now);
        leg.last_attempt = Some(now);
        leg.consecutive_failures = 0;
        leg.relayed += 1;
        leg.last_error = None;
        drop(legs);
    }

    /// Record a failed relay attempt to `room`. Returns the new consecutive
    /// failure count so the caller can escalate when the threshold is
    /// crossed.
    pub fn record_failure(&self, room: &str, error: &str) -> u32 {
        let mut legs = self
            .legs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let leg = legs.entry(room.to_owned()).or_default();
        leg.last_attempt = Some(Instant::now());
        leg.consecutive_failures += 1;
        leg.failed += 1;
        leg.last_error = Some(error.to_owned());
        let count = leg.consecutive_failures;
        drop(legs);
        count
    }

    /// Whether `room` has crossed the dead-leg threshold.
    #[must_use]
    pub fn is_dead(&self, room: &str) -> bool {
        let legs = self
            .legs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dead = legs
            .get(room)
            .is_some_and(|leg| leg.consecutive_failures >= DEAD_LEG_THRESHOLD);
        drop(legs);
        dead
    }

    /// Snapshot of all known legs, sorted by room id for stable output.
    #[must_use]
    pub fn report(&self) -> Vec<LegReport> {
        let legs = self
            .legs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut reports: Vec<LegReport> = legs
            .iter()
            .map(|(room, leg)| LegReport {
                room: room.clone(),
                healthy: leg.consecutive_failures < DEAD_LEG_THRESHOLD,
                consecutive_failures: leg.consecutive_failures,
                relayed: leg.relayed,
                failed: leg.failed,
                secs_since_success: leg.last_success.map(|t| t.elapsed().as_secs()),
                secs_since_attempt: leg.last_attempt.map(|t| t.elapsed().as_secs()),
                last_error: leg.last_error.clone(),
            })
            .collect();
        drop(legs);
        reports.sort_by(|a, b| a.room.cmp(&b.room));
        reports
    }

    /// Legs currently past the dead threshold.
    #[must_use]
    pub fn dead_legs(&self) -> Vec<LegReport> {
        self.report().into_iter().filter(|l| !l.healthy).collect()
    }

    /// Legs whose last success is older than `max_age` even though an
    /// attempt happened since — i.e. traffic is flowing but not getting
    /// through.
    #[must_use]
    pub fn stale_legs(&self, max_age: Duration) -> Vec<LegReport> {
        self.report()
            .into_iter()
            .filter(|l| {
                let stale_success = l.secs_since_success.is_none_or(|s| s > max_age.as_secs());
                let recent_attempt = l.secs_since_attempt.is_some_and(|s| s <= max_age.as_secs());
                stale_success && recent_attempt && l.failed > 0
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_resets_failure_streak() {
        let health = RelayHealth::new();
        assert_eq!(health.record_failure("!a:hs", "send failed"), 1);
        assert_eq!(health.record_failure("!a:hs", "send failed"), 2);
        health.record_success("!a:hs");
        let report = health.report();
        assert_eq!(report.len(), 1);
        assert!(report[0].healthy);
        assert_eq!(report[0].consecutive_failures, 0);
        assert_eq!(report[0].relayed, 1);
        assert_eq!(report[0].failed, 2);
    }

    #[test]
    fn leg_goes_dead_at_threshold_and_recovers() {
        let health = RelayHealth::new();
        for _ in 0..DEAD_LEG_THRESHOLD {
            health.record_failure("!gchat:hs", "M_FORBIDDEN");
        }
        assert!(health.is_dead("!gchat:hs"));
        assert_eq!(health.dead_legs().len(), 1);
        assert_eq!(health.dead_legs()[0].room, "!gchat:hs");

        // One success brings it back.
        health.record_success("!gchat:hs");
        assert!(!health.is_dead("!gchat:hs"));
        assert!(health.dead_legs().is_empty());
    }

    #[test]
    fn registered_leg_is_visible_before_any_traffic() {
        let health = RelayHealth::new();
        health.register("!quiet:hs");
        let report = health.report();
        assert_eq!(report.len(), 1);
        assert_eq!(report[0].room, "!quiet:hs");
        assert!(report[0].healthy);
        assert_eq!(report[0].relayed, 0);
        assert!(report[0].secs_since_success.is_none());
        assert!(report[0].summary().contains("last_success=never"));
    }

    #[test]
    fn threshold_crossing_is_reported_to_caller() {
        let health = RelayHealth::new();
        let mut crossed_at = None;
        for i in 1..=5u32 {
            let count = health.record_failure("!x:hs", "boom");
            if count == DEAD_LEG_THRESHOLD && crossed_at.is_none() {
                crossed_at = Some(i);
            }
        }
        assert_eq!(crossed_at, Some(DEAD_LEG_THRESHOLD));
    }

    #[test]
    fn unknown_room_is_not_dead_and_report_is_sorted() {
        let health = RelayHealth::new();
        assert!(!health.is_dead("!nobody:hs"));
        health.record_success("!b:hs");
        health.record_success("!a:hs");
        let rooms: Vec<_> = health.report().into_iter().map(|l| l.room).collect();
        assert_eq!(rooms, vec!["!a:hs", "!b:hs"]);
    }

    #[test]
    fn summary_mentions_dead_state_and_error() {
        let health = RelayHealth::new();
        for _ in 0..DEAD_LEG_THRESHOLD {
            health.record_failure("!gchat:hs", "M_FORBIDDEN");
        }
        let report = health.report();
        let line = report[0].summary();
        assert!(line.contains("DEAD"), "got: {line}");
        assert!(line.contains("M_FORBIDDEN"), "got: {line}");
    }
}
