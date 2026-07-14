//! Out-of-band liveness: an OS-thread watchdog and a startup guard.
//!
//! In-process (tokio) timeouts are not a complete defense: the previous
//! generation's main sync task once parked for ~49 hours on an await whose
//! timer never fired, and every tokio-based safeguard was parked right along
//! with it. The watchdog therefore runs on a dedicated OS thread — no tokio,
//! no async, no locks shared with the runtime — and observes a [`Heartbeat`]
//! the sync loop bumps on every iteration.
//!
//! If the heartbeat goes stale the watchdog exits the process (exit code
//! `70`). The container/service manager restarts the bot with its persisted
//! session/store, and the relay startup backfill (driven by the delivery
//! ledger) replays messages missed during the stall. A frozen bot self-heals
//! in minutes instead of silently sitting dead for days.
//!
//! The [`StartupGuard`] covers the window BEFORE the watchdog arms:
//! login/whoami, secret recovery, plugin startup and relay backfill all run
//! before the sync loop starts, and any of them can wedge on a half-dead
//! connection with no safety net otherwise.

use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use core::time::Duration;
use std::sync::Arc;
use std::time::Instant;

use tracing::{error, info};

/// Exit code used when the watchdog kills a stalled process (`EX_SOFTWARE`).
pub const WATCHDOG_EXIT_CODE: i32 = 70;

/// Monotonic heartbeat shared between the sync loop and the watchdog thread.
#[derive(Debug, Clone)]
pub struct Heartbeat {
    anchor: Instant,
    last_beat_ms: Arc<AtomicU64>,
}

impl Heartbeat {
    /// Create a heartbeat anchored at "now", already beaten once.
    #[must_use]
    pub fn new() -> Self {
        Self {
            anchor: Instant::now(),
            last_beat_ms: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Record progress. Called by the sync loop on every iteration and by
    /// the message handler (progress inside a long catch-up batch counts).
    pub fn beat(&self) {
        let elapsed_ms = u64::try_from(self.anchor.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_beat_ms.store(elapsed_ms, Ordering::Relaxed);
    }

    /// Time since the last beat.
    #[must_use]
    pub fn age(&self) -> Duration {
        let now_ms = u64::try_from(self.anchor.elapsed().as_millis()).unwrap_or(u64::MAX);
        let last_ms = self.last_beat_ms.load(Ordering::Relaxed);
        Duration::from_millis(now_ms.saturating_sub(last_ms))
    }
}

impl Default for Heartbeat {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether a heartbeat of `age` counts as stalled for `threshold`.
#[must_use]
pub const fn is_stalled(age: Duration, threshold: Duration) -> bool {
    age.as_millis() > threshold.as_millis()
}

/// Spawn the watchdog thread. Returns without spawning if `threshold` is
/// zero (watchdog disabled).
///
/// On stall the watchdog first arms a fallback thread that exits the process
/// unconditionally after a short grace period, and only then attempts to
/// log. The ordering matters: if logging itself is the blocked resource
/// (e.g. a stalled stderr pipe), the fallback still guarantees the exit.
///
/// # Panics
///
/// Panics if the OS refuses to spawn the watchdog thread (startup-time
/// resource exhaustion; running without a watchdog would be worse).
pub fn spawn(heartbeat: Heartbeat, threshold: Duration) {
    if threshold.is_zero() {
        info!("Watchdog disabled (threshold 0)");
        return;
    }
    let poll = (threshold / 4).clamp(Duration::from_secs(1), Duration::from_secs(10));
    info!(
        threshold_secs = threshold.as_secs(),
        poll_secs = poll.as_secs(),
        "Watchdog armed: process exits if the sync loop stalls"
    );
    std::thread::Builder::new()
        .name("sync-watchdog".to_owned())
        .spawn(move || {
            loop {
                std::thread::sleep(poll);
                let age = heartbeat.age();
                if is_stalled(age, threshold) {
                    // Guarantee the exit even if logging blocks.
                    std::thread::spawn(|| {
                        std::thread::sleep(Duration::from_secs(3));
                        std::process::exit(WATCHDOG_EXIT_CODE);
                    });
                    error!(
                        stalled_for_secs = age.as_secs(),
                        threshold_secs = threshold.as_secs(),
                        "WATCHDOG: sync loop has stalled — exiting so the supervisor restarts us"
                    );
                    eprintln!(
                        "WATCHDOG: sync loop stalled for {}s (threshold {}s); exiting with code {WATCHDOG_EXIT_CODE}",
                        age.as_secs(),
                        threshold.as_secs()
                    );
                    std::process::exit(WATCHDOG_EXIT_CODE);
                }
            }
        })
        .expect("failed to spawn watchdog thread");
}

/// Guard for the startup window (before the sync watchdog arms). Exits the
/// process if [`StartupGuard::disarm`] is not called within `deadline`.
#[derive(Debug)]
pub struct StartupGuard {
    done: Arc<AtomicBool>,
}

impl StartupGuard {
    /// Arm the guard on a plain OS thread.
    ///
    /// # Panics
    ///
    /// Panics if the OS refuses to spawn the guard thread (startup-time
    /// resource exhaustion; running unguarded would be worse).
    #[must_use]
    pub fn arm(deadline: Duration) -> Self {
        let done = Arc::new(AtomicBool::new(false));
        let done_in = Arc::clone(&done);
        std::thread::Builder::new()
            .name("startup-guard".to_owned())
            .spawn(move || {
                std::thread::sleep(deadline);
                if !done_in.load(Ordering::Relaxed) {
                    eprintln!(
                        "STARTUP GUARD: bot did not reach the sync loop within {}s; exiting with code {WATCHDOG_EXIT_CODE}",
                        deadline.as_secs(),
                    );
                    std::process::exit(WATCHDOG_EXIT_CODE);
                }
            })
            .expect("failed to spawn startup guard thread");
        Self { done }
    }

    /// Startup finished; the guard thread becomes a no-op.
    pub fn disarm(&self) {
        self.done.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stall_detection_thresholds() {
        let t = Duration::from_secs(300);
        assert!(!is_stalled(Duration::from_secs(0), t));
        assert!(!is_stalled(Duration::from_secs(299), t));
        assert!(!is_stalled(Duration::from_secs(300), t));
        assert!(is_stalled(Duration::from_secs(301), t));
        assert!(is_stalled(Duration::from_secs(60 * 60 * 49), t));
    }

    #[test]
    fn heartbeat_age_resets_on_beat() {
        let hb = Heartbeat::new();
        std::thread::sleep(Duration::from_millis(30));
        assert!(hb.age() >= Duration::from_millis(20));
        hb.beat();
        assert!(hb.age() < Duration::from_millis(20));
    }

    #[test]
    fn heartbeat_clones_share_state() {
        let hb = Heartbeat::new();
        let clone = hb.clone();
        std::thread::sleep(Duration::from_millis(30));
        clone.beat();
        assert!(hb.age() < Duration::from_millis(20));
    }

    #[test]
    fn disarmed_startup_guard_does_not_exit() {
        // If this test survives past the deadline, the guard was a no-op.
        let guard = StartupGuard::arm(Duration::from_millis(20));
        guard.disarm();
        std::thread::sleep(Duration::from_millis(60));
    }
}
