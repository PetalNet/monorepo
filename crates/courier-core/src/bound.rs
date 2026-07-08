//! Bounded operations: a deadline and bounded retries for every external
//! call.
//!
//! Nothing in this workspace is allowed to await the network without a
//! deadline. matrix-sdk sets `Duration::MAX` (i.e. no timeout) on media
//! downloads, and several SDK paths can park forever on a half-dead TCP
//! connection — a production freeze in the previous generation was exactly
//! that. Every external call goes through [`bounded`] or [`bounded_retry`] so
//! a single stuck request can only cost a bounded amount of time and is
//! always logged.

use core::fmt::Display;
use core::future::IntoFuture;
use core::time::Duration;

use anyhow::{Result, anyhow};
use tracing::warn;

/// Cap for the exponential retry backoff between attempts.
const MAX_RETRY_DELAY: Duration = Duration::from_secs(15);

/// Await `fut` with a hard deadline.
///
/// # Errors
///
/// Returns an error if the future resolves to an error, or if `timeout`
/// elapses first (the future is dropped, cancelling the underlying request).
pub async fn bounded<F, T, E>(op: &str, timeout: Duration, fut: F) -> Result<T>
where
    F: IntoFuture<Output = Result<T, E>>,
    E: Display,
{
    match tokio::time::timeout(timeout, fut.into_future()).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => Err(anyhow!("{op}: {e}")),
        Err(_) => Err(anyhow!("{op}: timed out after {}s", timeout.as_secs())),
    }
}

/// Await an operation with a per-attempt deadline and bounded retries.
///
/// `make_fut` is invoked once per attempt. Between failed attempts the delay
/// doubles from `base_delay`, capped at [`MAX_RETRY_DELAY`]. Every failed
/// attempt is logged at WARN with the operation name so per-call failures
/// are never silent.
///
/// # Errors
///
/// Returns the final error once all `attempts` have failed or timed out.
pub async fn bounded_retry<M, F, T, E>(
    op: &str,
    timeout: Duration,
    attempts: u32,
    base_delay: Duration,
    mut make_fut: M,
) -> Result<T>
where
    M: FnMut() -> F,
    F: IntoFuture<Output = Result<T, E>>,
    E: Display,
{
    let attempts = attempts.max(1);
    let mut delay = base_delay;
    let mut last_err = anyhow!("{op}: no attempts made");

    for attempt in 1..=attempts {
        match bounded(op, timeout, make_fut()).await {
            Ok(value) => return Ok(value),
            Err(e) => {
                warn!(op, attempt, max_attempts = attempts, error = %e, "Bounded operation attempt failed");
                last_err = e;
            }
        }
        if attempt < attempts {
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(MAX_RETRY_DELAY);
        }
    }

    Err(last_err)
}

#[cfg(test)]
mod tests {
    use core::convert::Infallible;
    use core::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn bounded_timeout_fires_on_hung_future() {
        // A future that never resolves — like a media download on a dead
        // connection — must be cut off at the deadline instead of hanging.
        let result: Result<()> = bounded(
            "hung-op",
            Duration::from_secs(5),
            core::future::pending::<Result<(), Infallible>>(),
        )
        .await;
        let err = result.expect_err("hung future must time out").to_string();
        assert!(err.contains("timed out after 5s"), "got: {err}");
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_passes_through_success() {
        let result = bounded(
            "ok-op",
            Duration::from_secs(5),
            core::future::ready(Ok::<_, Infallible>(42)),
        )
        .await;
        assert_eq!(result.expect("must succeed"), 42);
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_retry_succeeds_after_transient_failures() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_in = Arc::clone(&calls);
        let result = bounded_retry(
            "flaky-op",
            Duration::from_secs(5),
            3,
            Duration::from_millis(100),
            move || {
                let n = calls_in.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n < 2 {
                        Err("transient failure")
                    } else {
                        Ok("finally")
                    }
                }
            },
        )
        .await;
        assert_eq!(result.expect("third attempt must succeed"), "finally");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_retry_gives_up_after_max_attempts() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_in = Arc::clone(&calls);
        let result: Result<()> = bounded_retry(
            "dead-op",
            Duration::from_secs(5),
            3,
            Duration::from_millis(100),
            move || {
                calls_in.fetch_add(1, Ordering::SeqCst);
                core::future::ready(Err("permanent failure"))
            },
        )
        .await;
        assert!(result.is_err(), "must give up after all attempts fail");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "must stop at the attempt cap"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_retry_retries_timeouts_and_gives_up() {
        // Each attempt hangs; every one must be cut at its own deadline and
        // the whole operation must still terminate.
        let calls = Arc::new(AtomicU32::new(0));
        let calls_in = Arc::clone(&calls);
        let result: Result<()> = bounded_retry(
            "hung-op",
            Duration::from_secs(2),
            2,
            Duration::from_millis(100),
            move || {
                calls_in.fetch_add(1, Ordering::SeqCst);
                core::future::pending::<Result<(), Infallible>>()
            },
        )
        .await;
        let err = result.expect_err("must not hang").to_string();
        assert!(err.contains("timed out"), "got: {err}");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
