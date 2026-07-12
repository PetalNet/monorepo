//! The proxied map tier (Wave C): the app asks THIS server for tiles and the
//! server fetches them from the configured upstream provider. The provider
//! only ever sees this server's address and key, never a user. This is real
//! privacy for the "convenient" tier, not a cleaned-up surveillance feed; the
//! max-private tier (the instance's own tileserver) never touches an upstream
//! at all and is advertised separately in `/.well-known/point`.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::Semaphore;

use axum::extract::{Path, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Extension;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

use super::rate_limit::RateLimiter;

/// Per-user tile budget. A pan/zoom burst legitimately fetches dozens of
/// tiles; this bounds a runaway client without touching real use.
const TILES_PER_MINUTE: u32 = 600;

/// Upstream fetch timeout: tiles are small; a slow upstream should fail the
/// one tile, not hold the connection pool.
const TILE_TIMEOUT: Duration = Duration::from_secs(10);

/// A tile is a small raster; 2 MiB is generous headroom.
const MAX_TILE_BYTES: usize = 2 * 1024 * 1024;

/// Instance-wide ceiling on tiles being fetched from the upstream at once.
/// Bounds the blast radius of a slow upstream: extra requests wait briefly for
/// a slot rather than each pinning a connection for the full timeout. Well
/// above a few users panning; far below "one account ties up everything".
const MAX_CONCURRENT_UPSTREAM: usize = 32;

fn upstream_slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(MAX_CONCURRENT_UPSTREAM))
}

fn tile_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(TILE_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("static tile client config is valid")
    })
}

/// GET /api/tiles/{z}/{x}/{y} — fetch one upstream tile on the caller's
/// behalf. Requires auth (this is a member service, not an open proxy) and is
/// only wired when `TILE_UPSTREAM` is configured.
pub async fn get_tile(
    State(state): State<AppState>,
    Extension(limiter): Extension<Arc<RateLimiter>>,
    user: AuthUser,
    Path((z, x, y)): Path<(u8, u32, u32)>,
) -> ApiResult<Response> {
    limiter.check(&format!("tiles:{}", user.user_id), TILES_PER_MINUTE)?;

    let Some(upstream) = state.config.tile_upstream.as_deref() else {
        return Err(AppError::NotFound);
    };
    // Honest tile math: x/y must exist at this zoom.
    if z > 22 || u64::from(x) >= (1u64 << z) || u64::from(y) >= (1u64 << z) {
        return Err(AppError::BadRequest("no such tile".into()));
    }

    let url = upstream
        .replace("{z}", &z.to_string())
        .replace("{x}", &x.to_string())
        .replace("{y}", &y.to_string());

    // Hold a global slot for the whole upstream round-trip; if all are taken
    // (a slow upstream backing up), give up fast rather than queue unbounded.
    let _slot = upstream_slots()
        .try_acquire()
        .map_err(|_| AppError::TooManyRequests)?;

    let resp = tile_client()
        .get(&url)
        .send()
        .await
        .map_err(|_| AppError::BadRequest("tile upstream unreachable".into()))?;
    if !resp.status().is_success() {
        return Err(AppError::NotFound);
    }
    // Content type must be DECLARED and an image: a missing header no longer
    // gets an optimistic default, so an upstream can't relay unlabeled bytes.
    let content_type = match resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    {
        Some(ct) if ct.starts_with("image/") => ct.to_string(),
        _ => return Err(AppError::NotFound),
    };
    // A declared oversize is rejected before the body is read.
    if let Some(len) = resp.content_length() {
        if len > MAX_TILE_BYTES as u64 {
            return Err(AppError::NotFound);
        }
    }
    // Stream with a hard cap so a lying/chunked upstream can't force an
    // unbounded allocation: stop the moment we exceed the ceiling.
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| AppError::BadRequest("tile upstream failed".into()))?
    {
        if buf.len() + chunk.len() > MAX_TILE_BYTES {
            return Err(AppError::NotFound);
        }
        buf.extend_from_slice(&chunk);
    }
    if buf.is_empty() {
        return Err(AppError::NotFound);
    }
    let bytes = buf;

    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            // Tiles are static enough to cache client-side for a day.
            (header::CACHE_CONTROL, "public, max-age=86400".to_string()),
        ],
        bytes,
    )
        .into_response())
}
