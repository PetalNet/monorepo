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

/// A wake is intentionally CONTENTLESS on the wire: the body the distributor
/// relays is empty, so it learns nothing — not who, not where, not even the
/// coarse category of the event. The [kind] is kept only for FCM's data field
/// (Google is already trusted with delivery in that tier) and for logging; it
/// is never put in the UnifiedPush body. The client refreshes its request and
/// people surfaces on any wake, so it never needs the category to act.
#[derive(Debug, Clone, Serialize)]
pub struct Wake {
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

/// The host (no scheme, no port) of an `https://host[:port]/...` URL.
fn url_host(endpoint: &str) -> Option<String> {
    let rest = endpoint.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    // Strip userinfo and port; leave an IPv6 literal's brackets for the
    // denylist to catch.
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if authority.starts_with('[') {
        authority.split(']').next().map(|h| format!("{h}]"))?
    } else {
        authority
            .rsplit_once(':')
            .map_or(authority, |(h, _)| h)
            .to_string()
    };
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Wake every endpoint registered to `user_id`. Best-effort: errors are logged
/// and swallowed. Spawned by callers so it never blocks the request path.
/// `allow_private` (dev/test) skips the SSRF guard on the UnifiedPush endpoint.
pub async fn wake_user(pool: PgPool, user_id: String, wake: Wake, allow_private: bool) {
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
    for (transport, endpoint) in rows {
        match transport.as_str() {
            "unifiedpush" => send_unifiedpush(&endpoint, allow_private).await,
            "fcm" => send_fcm(&http, &endpoint, &wake).await,
            other => tracing::warn!(transport = %other, "push: unknown transport row"),
        }
    }
}

/// POST the opaque wake bytes to a UnifiedPush endpoint. The distributor
/// relays them to the device; it sees only "some bytes for Point".
///
/// The endpoint is a URL the user registered, so it gets the SAME SSRF
/// treatment as any outbound S2S fetch: the host is resolved, every resolved
/// IP must be public, and the connection is pinned to those exact addresses
/// (no re-resolution → no DNS-rebinding). A user cannot register
/// `https://169.254.169.254/...` or an internal host and make us probe it.
async fn send_unifiedpush(endpoint: &str, allow_private: bool) {
    if !endpoint.starts_with("https://") {
        tracing::warn!("push: refusing non-https UnifiedPush endpoint");
        return;
    }
    let host = match url_host(endpoint) {
        Some(h) => h,
        None => {
            tracing::warn!("push: unparsable UnifiedPush endpoint");
            return;
        }
    };
    let addrs = match crate::api::federation::ssrf_check(&host, allow_private).await {
        Ok(a) => a,
        Err(_) => {
            tracing::warn!(host = %host, "push: UnifiedPush endpoint failed SSRF check");
            return;
        }
    };
    let mut b = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none());
    if !addrs.is_empty() {
        b = b.resolve_to_addrs(&host, &addrs);
    }
    let http = match b.build() {
        Ok(c) => c,
        Err(_) => return,
    };
    match http
        .post(endpoint)
        .header("content-type", "application/json")
        // UnifiedPush high-priority hint (RFC 8030 urgency).
        .header("urgency", "high")
        .header("ttl", "86400")
        // Empty body: the distributor relays "a wake for Point" and nothing
        // more. The client pulls the detail over its authenticated channel.
        .body(Vec::<u8>::new())
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

#[cfg(test)]
mod tests {
    use super::url_host;

    #[test]
    fn url_host_extracts_host() {
        assert_eq!(
            url_host("https://ntfy.sh/upABC?up=1").as_deref(),
            Some("ntfy.sh")
        );
        assert_eq!(
            url_host("https://ntfy.sh:8443/x").as_deref(),
            Some("ntfy.sh")
        );
        assert_eq!(
            url_host("https://user:pw@host.example/x").as_deref(),
            Some("host.example")
        );
        assert_eq!(url_host("https://[::1]:443/x").as_deref(), Some("[::1]"));
        assert_eq!(url_host("http://ntfy.sh/x"), None); // not https
        assert_eq!(url_host("https:///x"), None); // empty host
    }
}
