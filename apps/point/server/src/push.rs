//! Transport-agnostic push wake (Wave D). When a user is offline (no live WS),
//! an event they'd want to know about — an incoming share request, an accept —
//! sends a WAKE to their registered push endpoints. The wake carries no who or
//! where: it only tells the device "a Point event is waiting", so the client
//! wakes and pulls the detail over its authenticated channel.
//!
//! Two transports, one interface:
//!   - UnifiedPush: POST the wake bytes to the endpoint URL the user's own
//!     distributor gave us. The distributor sees "wake Point", not the content.
//!   - FCM: POST a data-only message to FCM's HTTP v1 endpoint (best-effort;
//!     only active when a service-account credential is configured).
//!
//! Delivery is always best-effort and fire-and-forget: a failed wake must
//! never fail the user action that triggered it. The client still gets
//! everything on its next connect.

use std::time::Duration;

use serde::Serialize;
use sqlx::PgPool;

/// The wake body. Deliberately contentless beyond a type tag the client uses
/// to decide what to refresh; NEVER a name, location, or handle.
#[derive(Debug, Clone, Serialize)]
pub struct Wake {
    /// A coarse category so the client knows what to pull: `share_request`,
    /// `share_accepted`. Not the who or the where.
    pub kind: &'static str,
}

impl Wake {
    pub fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("static push client config is valid")
}

/// Wake every endpoint registered to `user_id`. Best-effort: errors are logged
/// and swallowed. Spawned by callers so it never blocks the request path.
pub async fn wake_user(pool: PgPool, user_id: String, wake: Wake) {
    let rows: Result<Vec<(String, String)>, _> =
        sqlx::query_as("SELECT transport, endpoint FROM push_endpoints WHERE user_id = $1")
            .bind(&user_id)
            .fetch_all(&pool)
            .await;
    let rows = match rows {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(user = %user_id, error = %e, "push: endpoint lookup failed");
            return;
        }
    };
    if rows.is_empty() {
        return;
    }
    let http = client();
    let body = serde_json::to_vec(&wake).unwrap_or_default();
    for (transport, endpoint) in rows {
        match transport.as_str() {
            "unifiedpush" => send_unifiedpush(&http, &endpoint, &body).await,
            "fcm" => send_fcm(&http, &endpoint, &wake).await,
            other => tracing::warn!(transport = %other, "push: unknown transport row"),
        }
    }
}

/// POST the opaque wake bytes to a UnifiedPush endpoint. The distributor
/// relays them to the device; it sees only "some bytes for Point".
async fn send_unifiedpush(http: &reqwest::Client, endpoint: &str, body: &[u8]) {
    // UnifiedPush endpoints are always full https URLs from a distributor. A
    // plain-http or malformed endpoint is dropped rather than fetched (an
    // attacker who registered one can't turn us into an SSRF probe).
    if !endpoint.starts_with("https://") {
        tracing::warn!("push: refusing non-https UnifiedPush endpoint");
        return;
    }
    match http
        .post(endpoint)
        .header("content-type", "application/json")
        // UnifiedPush high-priority hint (RFC 8030 urgency).
        .header("urgency", "high")
        .header("ttl", "86400")
        .body(body.to_vec())
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => tracing::info!(status = %r.status(), "push: UnifiedPush non-2xx"),
        Err(e) => tracing::info!(error = %e, "push: UnifiedPush send failed"),
    }
}

/// Best-effort FCM data message. Only attempts delivery when an FCM HTTP v1
/// endpoint + bearer are configured via env; otherwise it is a no-op so an
/// instance with no FCM project simply doesn't use that transport.
async fn send_fcm(http: &reqwest::Client, token: &str, wake: &Wake) {
    let (Some(url), Some(bearer)) = (fcm_url(), fcm_bearer()) else {
        // No FCM credential configured on this instance: FCM endpoints simply
        // don't get woken (the device falls back to on-open refresh).
        return;
    };
    let payload = serde_json::json!({
        "message": {
            "token": token,
            "data": { "kind": wake.kind },
            "android": { "priority": "high" },
        }
    });
    match http
        .post(&url)
        .bearer_auth(bearer)
        .json(&payload)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => tracing::info!(status = %r.status(), "push: FCM non-2xx"),
        Err(e) => tracing::info!(error = %e, "push: FCM send failed"),
    }
}

/// FCM HTTP v1 send URL, from `FCM_PROJECT_ID`. None = FCM disabled.
fn fcm_url() -> Option<String> {
    let project = std::env::var("FCM_PROJECT_ID")
        .ok()
        .filter(|v| !v.is_empty())?;
    Some(format!(
        "https://fcm.googleapis.com/v1/projects/{project}/messages:send"
    ))
}

/// FCM OAuth bearer, from `FCM_ACCESS_TOKEN` (a short-lived token minted by the
/// operator's service-account tooling and injected). None = FCM disabled.
///
/// v1 is a deliberate MVP: the operator supplies a current access token rather
/// than the server carrying a service-account private key + minting JWTs. A
/// self-hosted instance that wants FCM runs the standard gcloud/token refresher
/// alongside; the private path (UnifiedPush) needs none of this.
fn fcm_bearer() -> Option<String> {
    std::env::var("FCM_ACCESS_TOKEN")
        .ok()
        .filter(|v| !v.is_empty())
}
