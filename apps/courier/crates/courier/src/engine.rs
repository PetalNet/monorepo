//! The reliability core: a supervised sync loop.
//!
//! Replaces `client.sync(...)`, which had two fatal properties in the
//! previous generation:
//!
//! 1. Any sync error terminated the process ("sync terminated: ..."), so a
//!    single transient network blip crash-looped the bot.
//! 2. A single sync iteration could park forever (~49 hours once) with no
//!    deadline of our own around it.
//!
//! This loop calls `sync_once` directly, beats the liveness
//! [`Heartbeat`] on every turn, retries transient errors with capped
//! exponential backoff, and only returns for genuinely fatal conditions
//! (invalid token) where a process restart — and the startup re-login path —
//! is the correct recovery.
//!
//! Deliberately NO tokio timeout wraps `sync_once`: matrix-sdk persists the
//! sync token as soon as the response is received, BEFORE event handlers
//! run. A timeout firing mid-processing therefore advances the token past
//! events whose handlers never ran — those messages are lost forever (this
//! shipped once as a silent relay stall: the loop looked alive, health said
//! "ok", and incoming events were being skipped). Stall protection is the
//! OS-thread [`courier_core::watchdog`]: if an iteration genuinely hangs,
//! the heartbeat goes stale, the process exits, the container restarts it,
//! and the relay startup backfill (driven by the delivery ledger) replays
//! what was missed — nothing is silently dropped.

use core::time::Duration;
use std::sync::Arc;

use matrix_sdk::{Client, config::SyncSettings, ruma::api::client::error::ErrorKind};
use tracing::{error, info, warn};

use courier_core::{health::RelayHealth, supervise::Backoff, watchdog::Heartbeat};

/// Runtime knobs for the sync loop. All values come from CLI flags/env with
/// safe defaults; see `Args`.
#[derive(Debug, Clone, Copy)]
pub struct EngineConfig {
    /// Long-poll timeout passed to the server.
    pub sync_timeout: Duration,
}

/// Outcome of one sync iteration, factored out for testability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IterationOutcome {
    /// Sync succeeded; keep going immediately.
    Success,
    /// Transient failure; sleep with backoff and keep going.
    Transient,
    /// Unrecoverable (e.g. invalid token); exit so the restart + re-login
    /// path can heal the session.
    Fatal,
}

/// What the loop does next for a given outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopAction {
    /// Continue immediately.
    Continue,
    /// Sleep for the given delay, then continue.
    Sleep(Duration),
    /// Return an error from the loop.
    Exit,
}

/// Pure decision function: one bad iteration must never end the loop unless
/// it is fatal.
#[must_use]
pub fn next_action(outcome: IterationOutcome, backoff: &mut Backoff) -> LoopAction {
    match outcome {
        IterationOutcome::Success => {
            backoff.reset();
            LoopAction::Continue
        }
        IterationOutcome::Transient => LoopAction::Sleep(backoff.next_delay()),
        IterationOutcome::Fatal => LoopAction::Exit,
    }
}

/// Classify a sync error. Only authentication death is fatal: everything
/// else (network, server 5xx, rate limits, parse noise) is worth retrying
/// forever — the bot must ride out homeserver and ISP outages.
#[must_use]
pub fn classify_sync_error(error: &matrix_sdk::Error) -> IterationOutcome {
    match error.client_api_error_kind() {
        Some(ErrorKind::UnknownToken { .. }) => IterationOutcome::Fatal,
        _ => IterationOutcome::Transient,
    }
}

/// Run the supervised sync loop. Only returns on fatal errors.
///
/// # Errors
///
/// Returns an error when the session token is rejected by the homeserver;
/// the caller should exit so the container restart re-login path recovers.
pub async fn run(
    client: &Client,
    config: EngineConfig,
    heartbeat: Heartbeat,
) -> anyhow::Result<()> {
    let settings = SyncSettings::new().timeout(config.sync_timeout);
    let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
    let mut consecutive_failures: u64 = 0;

    info!(
        sync_timeout_secs = config.sync_timeout.as_secs(),
        "Sync engine starting (no per-iteration timeout; OS watchdog covers stalls)"
    );

    loop {
        heartbeat.beat();

        // No tokio timeout here — see the module docs. Cancelling sync_once
        // mid-processing loses events because the sync token is persisted
        // before handlers run. A genuinely hung iteration stops the
        // heartbeat and the OS-thread watchdog restarts the process instead.
        let outcome = match client.sync_once(settings.clone()).await {
            Ok(_response) => IterationOutcome::Success,
            Err(e) => {
                let outcome = classify_sync_error(&e);
                match outcome {
                    IterationOutcome::Fatal => {
                        error!(error = %e, "Fatal sync error (auth); exiting for restart + re-login");
                    }
                    IterationOutcome::Success | IterationOutcome::Transient => {
                        consecutive_failures += 1;
                        warn!(
                            error = %e,
                            consecutive_failures,
                            "Transient sync error; will retry with backoff"
                        );
                    }
                }
                outcome
            }
        };

        if outcome == IterationOutcome::Success {
            if consecutive_failures > 0 {
                info!(after_failures = consecutive_failures, "Sync recovered");
            }
            consecutive_failures = 0;
        }

        match next_action(outcome, &mut backoff) {
            LoopAction::Continue => {}
            LoopAction::Sleep(delay) => tokio::time::sleep(delay).await,
            LoopAction::Exit => {
                return Err(anyhow::anyhow!(
                    "sync loop exited: session token rejected by homeserver"
                ));
            }
        }
    }
}

/// Periodically log per-leg relay health so a dead leg is loudly visible in
/// the logs (and in anything scraping them) even when nobody runs `!diag`.
pub async fn health_reporter(health: Arc<RelayHealth>, interval: Duration) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick fires immediately; skip it so startup logs stay clean.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let report = health.report();
        if report.is_empty() {
            info!("Relay health: no relay traffic yet");
            continue;
        }
        for leg in &report {
            if leg.healthy {
                info!(leg = %leg.summary(), "Relay health");
            } else {
                error!(leg = %leg.summary(), "Relay health: LEG IS DEAD — messages are NOT being delivered");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_errors_backoff_and_never_exit() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(8));
        // A long run of bad iterations only ever sleeps, never exits.
        let mut delays = Vec::new();
        for _ in 0..6 {
            match next_action(IterationOutcome::Transient, &mut backoff) {
                LoopAction::Sleep(d) => delays.push(d.as_secs()),
                LoopAction::Continue | LoopAction::Exit => {
                    panic!("transient must map to Sleep")
                }
            }
        }
        assert_eq!(delays, vec![1, 2, 4, 8, 8, 8], "exponential, capped");
    }

    #[test]
    fn success_resets_backoff() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        let _ = next_action(IterationOutcome::Transient, &mut backoff);
        let _ = next_action(IterationOutcome::Transient, &mut backoff);
        assert_eq!(
            next_action(IterationOutcome::Success, &mut backoff),
            LoopAction::Continue
        );
        // Next transient starts from the minimum again.
        assert_eq!(
            next_action(IterationOutcome::Transient, &mut backoff),
            LoopAction::Sleep(Duration::from_secs(1))
        );
    }

    #[test]
    fn fatal_exits() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        assert_eq!(
            next_action(IterationOutcome::Fatal, &mut backoff),
            LoopAction::Exit
        );
    }
}
