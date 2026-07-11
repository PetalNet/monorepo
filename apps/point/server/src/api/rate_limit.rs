//! Fixed-window in-memory rate limiting, lifted from legacy but with GC:
//! legacy's DashMap grew forever; here expired windows are swept
//! opportunistically on insert once the map is large — no background task.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use dashmap::DashMap;

use crate::error::AppError;

const WINDOW_SECS: u64 = 60;
/// GC trigger: only sweep when the map could actually matter memory-wise.
const GC_THRESHOLD: usize = 10_000;

/// One instance per router (constructed in `api::router`), shared across
/// handlers via an `Extension` layer.
#[derive(Default)]
pub struct RateLimiter {
    /// key -> (window id, hits in that window)
    windows: DashMap<String, (u64, u32)>,
}

impl RateLimiter {
    /// Count one hit against `key`; error once `limit` hits are exceeded within
    /// the current 60s window. Callers check limits *before* doing any work so
    /// rejected attempts stay cheap.
    pub fn check(&self, key: &str, limit: u32) -> Result<(), AppError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let window = now / WINDOW_SECS;

        if self.windows.len() > GC_THRESHOLD {
            self.windows.retain(|_, (w, _)| *w == window);
        }

        let mut entry = self.windows.entry(key.to_string()).or_insert((window, 0));
        if entry.0 != window {
            *entry = (window, 0);
        }
        entry.1 += 1;
        if entry.1 > limit {
            return Err(AppError::TooManyRequests);
        }
        Ok(())
    }
}

/// Whether the reverse-proxy client-IP header (`X-Real-IP`) may be trusted,
/// threaded into every request via an `Extension` layer set from `Config`.
/// Absent extension is treated as `false` (fail closed: don't trust headers).
#[derive(Clone, Copy)]
pub struct TrustProxy(pub bool);

/// Best-effort client address for rate-limit keying. When the server is behind
/// a trusted reverse proxy, honor `X-Real-IP`; otherwise ALWAYS use the peer
/// `SocketAddr` (an unproxied server must never let a client spoof its own
/// rate-limit bucket via a header). Missing peer info degrades to a shared
/// bucket — the fail-closed direction for a limiter.
pub struct ClientIp(pub String);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Infallible> {
        let trust_proxy = parts
            .extensions
            .get::<TrustProxy>()
            .map(|t| t.0)
            .unwrap_or(false);
        let header_ip = if trust_proxy {
            parts
                .headers
                .get("x-real-ip")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        } else {
            None
        };
        let ip = header_ip
            .or_else(|| {
                parts
                    .extensions
                    .get::<ConnectInfo<SocketAddr>>()
                    .map(|ci| ci.0.ip().to_string())
            })
            .unwrap_or_else(|| "unknown".to_string());
        Ok(ClientIp(ip))
    }
}
