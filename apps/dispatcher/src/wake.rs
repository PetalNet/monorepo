//! Wake rate-limiting — the thundering-herd guard (DP10).
//!
//! The dispatcher wakes warm sessions when there's ready work; waking many at
//! once stampedes the store (fleet-dispatcher-review §5). Standard guard:
//! token bucket + full jitter. Deterministic core (a clock is passed in), so
//! the tight-loop property is provable in tests.

use core::time::Duration;

use rand::RngExt as _;

#[derive(Debug)]
pub struct TokenBucket {
    capacity: f64,
    tokens: f64,
    refill_per_ms: f64,
    last_ms: i64,
}

impl TokenBucket {
    /// `rate_per_sec` sustained wakes/second, bursting to `capacity`.
    #[must_use]
    pub fn new(rate_per_sec: f64, capacity: f64, now_ms: i64) -> Self {
        Self {
            capacity,
            tokens: capacity,
            refill_per_ms: rate_per_sec / 1000.0,
            last_ms: now_ms,
        }
    }

    /// Try to take one token at `now_ms`. Ok = wake now; Err(wait) = earliest
    /// duration after which a token will exist (caller sleeps AND jitters).
    ///
    /// # Errors
    /// Returns the advised wait duration if no token is available.
    pub fn try_take(&mut self, now_ms: i64) -> Result<(), Duration> {
        #[expect(
            clippy::cast_precision_loss,
            reason = "Elapsed milliseconds intentionally round to floating-point refill units"
        )]
        let elapsed = (now_ms - self.last_ms).max(0) as f64;
        self.tokens = (self.tokens + elapsed * self.refill_per_ms).min(self.capacity);
        self.last_ms = now_ms;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            Ok(())
        } else {
            let deficit = 1.0 - self.tokens;
            Err(Duration::from_millis(saturating_millis(
                (deficit / self.refill_per_ms).ceil(),
            )))
        }
    }
}

// Preserve Rust's saturating float-to-u64 conversion for every configured
// rate: negative/NaN -> 0, overflow/infinity -> MAX, otherwise truncate.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Rust's saturating float cast is the intended wait-duration conversion"
)]
const fn saturating_millis(value: f64) -> u64 {
    value as u64
}

/// Full jitter over `base`: uniform in [0, base]. AWS-style; avoids
/// synchronized retry waves.
#[must_use]
pub fn full_jitter(base: Duration) -> Duration {
    if base.is_zero() {
        return base;
    }
    // Keep the original low-64-bit millisecond range even for huge durations.
    let base_ms = base
        .as_secs()
        .wrapping_mul(1000)
        .wrapping_add(u64::from(base.subsec_millis()));
    let ms = rand::rng().random_range(0..=base_ms);
    Duration::from_millis(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn millisecond_conversion_preserves_truncation_and_saturation() {
        for (value, expected) in [
            (f64::NAN, 0),
            (f64::NEG_INFINITY, 0),
            (-1.0, 0),
            (0.0, 0),
            (0.9, 0),
            (1.0, 1),
            (500.9, 500),
            (4_294_967_297.0, 4_294_967_297),
            (9_007_199_254_740_992.0, 9_007_199_254_740_992),
            (18_446_744_073_709_549_568.0, u64::MAX - 2047),
            (18_446_744_073_709_551_616.0, u64::MAX),
            (f64::INFINITY, u64::MAX),
        ] {
            assert_eq!(saturating_millis(value), expected, "{value}");
        }
    }

    #[test]
    fn zero_and_negative_rates_keep_the_existing_wait_behavior() {
        let mut stopped = TokenBucket::new(0.0, 1.0, 0);
        stopped.try_take(0).unwrap();
        assert_eq!(stopped.try_take(0), Err(Duration::from_millis(u64::MAX)));
        let mut negative = TokenBucket::new(-1.0, 1.0, 0);
        negative.try_take(0).unwrap();
        assert_eq!(negative.try_take(0), Err(Duration::ZERO));
    }

    #[test]
    fn burst_then_throttle() {
        let mut tb = TokenBucket::new(2.0, 5.0, 0);
        // Burst: 5 immediate wakes pass.
        for i in 0..5 {
            assert!(tb.try_take(0).is_ok(), "burst wake {i}");
        }
        // The 6th is throttled with a bounded, non-zero wait.
        let wait = tb.try_take(0).unwrap_err();
        assert!(
            wait > Duration::ZERO && wait <= Duration::from_millis(500),
            "{wait:?}"
        );
    }

    #[test]
    fn refill_restores_capacity_but_never_exceeds_it() {
        let mut tb = TokenBucket::new(2.0, 5.0, 0);
        for _ in 0..5 {
            tb.try_take(0).unwrap();
        }
        // After 10s at 2/s the bucket is full again — but capped at 5, not 20.
        for i in 0..5 {
            assert!(tb.try_take(10_000).is_ok(), "refilled wake {i}");
        }
        assert!(tb.try_take(10_000).is_err(), "capacity is capped");
    }

    #[test]
    fn no_tight_loop_under_sustained_demand() {
        // 100 wake attempts at 10/s sustained: the bucket must spread them out,
        // i.e. the advised waits sum to ≈ the theoretical drain time, never 0.
        let mut tb = TokenBucket::new(10.0, 1.0, 0);
        let mut now = 0i64;
        let mut granted = 0;
        let mut iterations = 0;
        while granted < 100 {
            iterations += 1;
            assert!(iterations < 10_000, "tight loop detected");
            match tb.try_take(now) {
                Ok(()) => granted += 1,
                Err(wait) => {
                    assert!(wait >= Duration::from_millis(1));
                    now += i64::try_from(wait.as_millis()).unwrap();
                }
            }
        }
        // 100 grants at 10/s from a 1-token bucket ≈ 9.9s minimum.
        assert!(now >= 9_800, "drained too fast: {now}ms");
    }

    #[test]
    fn jitter_stays_in_range() {
        for _ in 0..100 {
            let j = full_jitter(Duration::from_millis(300));
            assert!(j <= Duration::from_millis(300));
        }
        assert_eq!(full_jitter(Duration::ZERO), Duration::ZERO);
    }
}
