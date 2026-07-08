//! Fault isolation and backoff: the supervision primitives.
//!
//! Every piece of plugin work — command, mention, or passive handler — runs
//! through [`spawn_supervised`]: its own task, a hard time budget, and panic
//! containment. One bad event or plugin can log an error at worst; it can
//! never stall or kill the relay loop.
//!
//! [`Backoff`] is the shared capped-exponential schedule used by the sync
//! engine (and anything else that retries forever).

use core::future::Future;
use core::panic::AssertUnwindSafe;
use core::time::Duration;

use anyhow::Result;
use futures_util::FutureExt as _;
use tracing::{error, warn};

/// Spawn plugin work isolated from the caller: its own task, a hard time
/// budget, and panic containment.
pub fn spawn_supervised<F>(what: &'static str, plugin_id: String, budget: Duration, fut: F)
where
    F: Future<Output = Result<()>> + Send + 'static,
{
    tokio::spawn(async move {
        match AssertUnwindSafe(tokio::time::timeout(budget, fut))
            .catch_unwind()
            .await
        {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => {
                warn!(error = %e, plugin = %plugin_id, what, "Plugin handler failed");
            }
            Ok(Err(_elapsed)) => {
                warn!(
                    plugin = %plugin_id,
                    what,
                    budget_secs = budget.as_secs(),
                    "Plugin handler timed out; event skipped"
                );
            }
            Err(_panic) => {
                error!(
                    plugin = %plugin_id,
                    what,
                    "Plugin handler PANICKED; event skipped, loop continues"
                );
            }
        }
    });
}

/// Capped exponential backoff schedule for retrying transient failures.
#[derive(Debug, Clone, Copy)]
pub struct Backoff {
    current: Duration,
    min: Duration,
    max: Duration,
}

impl Backoff {
    /// A fresh schedule from `min` to `max`.
    #[must_use]
    pub const fn new(min: Duration, max: Duration) -> Self {
        Self {
            current: min,
            min,
            max,
        }
    }

    /// Delay to sleep now; doubles the next delay up to the cap.
    pub fn next_delay(&mut self) -> Duration {
        let delay = self.current;
        self.current = (self.current * 2).min(self.max);
        delay
    }

    /// Reset after a success.
    pub const fn reset(&mut self) {
        self.current = self.min;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(8));
        let delays: Vec<u64> = (0..6).map(|_| backoff.next_delay().as_secs()).collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 8, 8]);
    }

    #[test]
    fn backoff_reset_starts_over() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        let _ = backoff.next_delay();
        let _ = backoff.next_delay();
        backoff.reset();
        assert_eq!(backoff.next_delay(), Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn one_bad_handler_does_not_stall_others() {
        use core::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        // A hanging handler and a panicking handler are both isolated; a
        // healthy handler spawned afterwards still completes.
        let done = Arc::new(AtomicBool::new(false));

        spawn_supervised(
            "test",
            "hangs-forever".to_owned(),
            Duration::from_secs(1),
            async {
                core::future::pending::<()>().await;
                Ok(())
            },
        );
        spawn_supervised("test", "panics".to_owned(), Duration::from_secs(1), async {
            panic!("boom")
        });
        let done_in = Arc::clone(&done);
        spawn_supervised(
            "test",
            "healthy".to_owned(),
            Duration::from_secs(1),
            async move {
                done_in.store(true, Ordering::SeqCst);
                Ok(())
            },
        );

        // Advance past every budget; the healthy handler must have run and
        // the runtime must still be alive despite the hang + panic.
        tokio::time::sleep(Duration::from_secs(5)).await;
        tokio::task::yield_now().await;
        assert!(done.load(Ordering::SeqCst), "healthy handler must complete");
    }
}
