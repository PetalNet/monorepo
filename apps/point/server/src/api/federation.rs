//! Cross-instance E2E location sharing (M3 federation): discovery, signed
//! server-to-server (S2S) relay, TOFU identity pinning. The two servers relay
//! CIPHERTEXT ONLY — a federated share stays a green native-E2E relationship,
//! and neither server ever sees plaintext. Lifts the DESIGN from the legacy
//! skeleton (docs/legacy/server-map.md §5) while fixing its four sharp edges:
//!
//!   1. **Signing** — sign/verify the EXACT request-body bytes, never a
//!      serde-reserialized struct (the legacy canonicalization fragility). The
//!      inbox reads the body as `Bytes` BEFORE JSON parsing and verifies against
//!      those raw bytes with the origin domain's published key.
//!   2. **SSRF** — before any outbound S2S HTTP we RESOLVE the target and reject
//!      if any resolved IP is loopback/private/link-local/etc (defeats DNS
//!      rebinding), plus a hostname denylist. Gated off by
//!      `FEDERATION_ALLOW_PRIVATE=true` for the localhost integration test.
//!   3. **TOFU-pin** — `federation_pins` pins a hash of each remote user's MLS
//!      identity key on first contact; a later contact with a *different* key is
//!      a loud, fail-closed `Forbidden` (the forced-re-verify signal).
//!   4. **Replay** — S2S messages outside ±300s of now are rejected.
//!
//! Every delivery decision still routes through the fail-closed `authz` gate.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::{Extension, Json};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::auth::AuthUser;
use crate::authz;
use crate::error::{ApiResult, AppError};
use crate::federation_keys;
use crate::state::AppState;

use super::mls::{insert_mailbox, push_mailbox, validate_group_id, MAX_MLS_PAYLOAD_BYTES};
use super::rate_limit::{ClientIp, RateLimiter};

/// Per-source-IP ceiling on inbox POSTs. The inbox is anonymous until the
/// signature verifies (which itself costs an outbound discovery fetch), so this
/// is the throttle that stops an attacker turning us into a reflected-DoS
/// amplifier or flooding shadow-user/pin writes (HIGH-3).
const INBOX_PER_MINUTE: u32 = 120;

/// S2S messages must be within this many seconds of now (replay window, ±).
const REPLAY_WINDOW_SECS: i64 = 300;
/// A single encrypted fix is small; 16KB decoded is already generous (matches
/// the WS `location.update` ceiling).
const MAX_LOCATION_BLOB_BYTES: usize = 16 * 1024;
/// An MLS identity/credential key is small; cap the decoded size we'll hash.
const MAX_IDENTITY_KEY_BYTES: usize = 4096;
/// Outbound S2S request timeout.
const S2S_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// wire types
// ---------------------------------------------------------------------------

/// The signed S2S envelope. Signed/verified as EXACT bytes — field order is
/// irrelevant because we never re-serialize to verify.
#[derive(Debug, Serialize, Deserialize)]
pub struct FederatedMessage {
    /// Full sender id, `name@sender_domain`.
    pub sender: String,
    /// Full recipient id, `name@local_domain`.
    pub recipient: String,
    pub message_type: String,
    #[serde(default)]
    pub payload: Value,
    /// Sender-claimed epoch SECONDS (replay-window checked).
    pub timestamp: i64,
}

/// The subset of a peer's `/.well-known/point` we consume.
#[derive(Debug, Deserialize)]
struct RemoteWellKnown {
    public_key: String,
    endpoints: RemoteEndpoints,
}

#[derive(Debug, Deserialize)]
struct RemoteEndpoints {
    inbox: String,
}

// ---------------------------------------------------------------------------
// discovery (unauthenticated)
// ---------------------------------------------------------------------------

/// GET /.well-known/point — discovery. Publishes our domain, version, the
/// federation flag, this instance's Ed25519 public key (hex), and the inbox
/// endpoint. `endpoints.keys` intentionally points at the inbox too (KeyPackage
/// fetch is an `mls.key_request` message to the inbox) — the legacy skeleton
/// advertised a `keys` route it never registered (a 404); this keeps discovery
/// honest.
pub async fn well_known(State(state): State<AppState>) -> Json<Value> {
    let inbox = format!(
        "{}/federation/inbox",
        state.config.public_url.trim_end_matches('/')
    );
    // The map endpoints (Wave C): `tiles` is the instance's OWN tileserver
    // (max-private tier, template URL); `tile_proxy` says whether this server
    // proxies an upstream provider for the convenient tier.
    let mut endpoints = json!({ "inbox": inbox, "keys": inbox });
    if let Some(tiles) = &state.config.tiles_url {
        endpoints["tiles"] = json!(tiles);
    }
    endpoints["tile_proxy"] = json!(state.config.tile_upstream.is_some());
    Json(json!({
        "domain": state.config.domain,
        "version": 1,
        "federation": true,
        "public_key": federation_keys::public_key_hex(&state.server_signing_key),
        "endpoints": endpoints,
    }))
}

// ---------------------------------------------------------------------------
// inbox (unauthenticated at the HTTP layer — auth IS the signature)
// ---------------------------------------------------------------------------

/// POST /federation/inbox — receive a signed S2S message. `body` is extracted
/// as raw `Bytes` (last), so we verify the signature over the EXACT received
/// bytes, never a reparse.
///
/// Flow: parse → extract sender domain → SSRF-check it → discover the sender's
/// well-known → verify `X-Point-Signature` over the raw bytes with the sender's
/// published key → replay-window check → recipient-is-local check → dispatch.
pub async fn inbox(
    State(state): State<AppState>,
    Extension(limiter): Extension<Arc<RateLimiter>>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Json<Value>> {
    // The inbox is unauthenticated until the signature verifies, and verifying
    // needs an outbound discovery fetch — so throttle per source IP first, or an
    // anonymous attacker could make us hammer arbitrary domains (reflected DoS)
    // and flood shadow-user/pin writes (HIGH-3).
    limiter.check(&format!("fed:inbox:{ip}"), INBOX_PER_MINUTE)?;

    // The signature IS the authentication. No signature / no origin = 401.
    let sig = header_str(&headers, "x-point-signature").ok_or(AppError::Unauthorized)?;
    let origin = header_str(&headers, "x-point-origin").ok_or(AppError::Unauthorized)?;

    let msg: FederatedMessage = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("invalid federated message".into()))?;

    let sender = msg.sender.trim().to_lowercase();
    let recipient = msg.recipient.trim().to_lowercase();
    let sender_domain = domain_of(&sender)
        .ok_or_else(|| AppError::BadRequest("sender has no domain".into()))?
        .to_string();

    // The advertised origin must match the signer's domain, or the signature is
    // being replayed under a different banner.
    if !origin.trim().eq_ignore_ascii_case(&sender_domain) {
        return Err(AppError::Unauthorized);
    }

    let allow_private = state.config.federation_allow_private;

    // Live-fetch the sender's published signing key (discover() SSRF-checks +
    // pins the connection) and verify the raw bytes.
    let peer = discover(&sender_domain, allow_private).await?;
    if !federation_keys::verify(&peer.public_key, &body, sig) {
        tracing::warn!(sender = %sender, "federation: bad S2S signature — rejecting");
        return Err(AppError::Unauthorized);
    }

    // Replay window: reject anything too far from now (either direction).
    if !replay_ok(msg.timestamp, Utc::now().timestamp()) {
        tracing::warn!(sender = %sender, "federation: message outside replay window — rejecting");
        return Err(AppError::Unauthorized);
    }

    // The recipient must be a local user (this instance's domain).
    match domain_of(&recipient) {
        Some(d) if d.eq_ignore_ascii_case(&state.config.domain) => {}
        _ => return Err(AppError::NotFound),
    }

    let out = dispatch(&state, &sender, &recipient, &msg.message_type, &msg.payload).await?;
    Ok(Json(out))
}

async fn dispatch(
    state: &AppState,
    sender: &str,
    recipient: &str,
    message_type: &str,
    payload: &Value,
) -> ApiResult<Value> {
    match message_type {
        "share.request" => handle_share_request(state, sender, recipient, payload).await,
        "share.accept" => handle_share_accept(state, sender, recipient, payload).await,
        "share.remove" => handle_share_remove(state, sender, recipient).await,
        "profile.updated" => handle_profile_updated(state, sender, recipient, payload).await,
        "mls.key_request" => handle_key_request(state, sender, recipient, payload).await,
        "mls.welcome" => handle_mls_relay(state, sender, recipient, payload, "welcome").await,
        "mls.commit" => handle_mls_relay(state, sender, recipient, payload, "commit").await,
        "location.update" => handle_location_update(state, sender, recipient, payload).await,
        _ => Err(AppError::BadRequest("unknown message_type".into())),
    }
}

async fn handle_profile_updated(
    state: &AppState,
    sender: &str,
    recipient: &str,
    payload: &Value,
) -> ApiResult<Value> {
    if !authz::can_view_profile(&state.pool, recipient, sender).await? {
        return Err(AppError::Forbidden);
    }
    let display_name = payload
        .get("display_name")
        .and_then(Value::as_str)
        .map(super::auth::sanitize_display_name)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::BadRequest("invalid profile display_name".into()))?;
    let profile_version = payload
        .get("profile_version")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::BadRequest("invalid profile_version".into()))?;
    let avatar_changed = payload
        .get("avatar_changed")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let avatar = if avatar_changed {
        match payload.get("avatar") {
            None | Some(Value::Null) => None,
            Some(Value::String(encoded)) => {
                let bytes = BASE64
                    .decode(encoded)
                    .map_err(|_| AppError::BadRequest("invalid profile avatar".into()))?;
                if bytes.is_empty() || bytes.len() > super::account::MAX_AVATAR_BYTES {
                    return Err(AppError::BadRequest("invalid profile avatar".into()));
                }
                Some(bytes)
            }
            _ => return Err(AppError::BadRequest("invalid profile avatar".into())),
        }
    } else {
        None
    };
    let avatar_mime = if avatar_changed {
        payload.get("avatar_mime").and_then(Value::as_str)
    } else {
        None
    };
    if let Some(bytes) = &avatar {
        let Some(mime) = avatar_mime else {
            return Err(AppError::BadRequest("invalid profile avatar mime".into()));
        };
        if !super::account::avatar_bytes_match_mime(bytes, mime) {
            return Err(AppError::BadRequest("invalid profile avatar mime".into()));
        }
    }

    let result = if avatar_changed {
        sqlx::query(
            "UPDATE users
             SET display_name = $1, avatar = $2, avatar_mime = $3, updated_at = now()
             WHERE id = $4 AND is_federated",
        )
        .bind(&display_name)
        .bind(&avatar)
        .bind(avatar_mime)
        .bind(sender)
        .execute(&state.pool)
        .await?
    } else {
        sqlx::query(
            "UPDATE users SET display_name = $1, updated_at = now()
             WHERE id = $2 AND is_federated",
        )
        .bind(&display_name)
        .bind(sender)
        .execute(&state.pool)
        .await?
    };
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    sqlx::query("UPDATE entities SET display_name = $1 WHERE owner_id = $2 AND kind = 'person'")
        .bind(&display_name)
        .bind(sender)
        .execute(&state.pool)
        .await?;

    state.hub.send_to_user(
        recipient,
        &json!({
            "type": "profile.updated",
            "user_id": sender,
            "profile_version": profile_version,
            "avatar_changed": avatar_changed,
        })
        .to_string(),
    );
    Ok(json!({ "ok": true }))
}

async fn handle_share_remove(state: &AppState, sender: &str, recipient: &str) -> ApiResult<Value> {
    let (lo, hi) = if sender < recipient {
        (sender, recipient)
    } else {
        (recipient, sender)
    };
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM user_shares WHERE user_a = $1 AND user_b = $2")
        .bind(lo)
        .bind(hi)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM share_requests
         WHERE (from_user_id = $1 AND to_user_id = $2)
            OR (from_user_id = $2 AND to_user_id = $1)",
    )
    .bind(sender)
    .bind(recipient)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    state.hub.send_to_user(
        recipient,
        &json!({ "type": "share.removed", "user_id": sender }).to_string(),
    );
    tokio::spawn(crate::push::wake_user(
        state.pool.clone(),
        recipient.to_string(),
        crate::push::Wake::new("share_removed"),
        state.config.federation_allow_private,
    ));
    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// message handlers
// ---------------------------------------------------------------------------

/// `share.request`: a remote user asks to share with a LOCAL user. Create the
/// federated shadow user, TOFU-pin their identity key, and open a pending
/// inbound share request.
async fn handle_share_request(
    state: &AppState,
    sender: &str,
    recipient: &str,
    payload: &Value,
) -> ApiResult<Value> {
    let key_hash = identity_key_hash(payload).ok_or_else(|| {
        AppError::BadRequest("share.request: missing/invalid identity_key".into())
    })?;

    // Recipient gate FIRST, before any pin/shadow-row writes: a nonexistent
    // recipient and a blocked one must be indistinguishable from outside
    // (both the same generic ok), or the difference becomes an existence
    // oracle. who_can_add_me (Wave B): a federated ask is blocked by both
    // 'nobody' and 'same_server'.
    let gate: Option<(String,)> =
        sqlx::query_as("SELECT who_can_add_me FROM users WHERE id = $1 AND NOT is_federated")
            .bind(recipient)
            .fetch_optional(&state.pool)
            .await?;
    match gate {
        Some((ref v,)) if v == "anyone" => {}
        _ => return Ok(json!({ "ok": true })),
    }

    ensure_federated_user(&state.pool, sender).await?;
    tofu_pin(&state.pool, recipient, sender, &key_hash).await?;

    // Idempotent pending request sender -> recipient (mirrors the local share
    // request UPSERT ladder: re-open a prior rejected/accepted row).
    sqlx::query(
        "INSERT INTO share_requests (from_user_id, to_user_id) VALUES ($1, $2)
         ON CONFLICT (from_user_id, to_user_id)
         DO UPDATE SET status = 'pending', updated_at = now()
         WHERE share_requests.status <> 'pending'",
    )
    .bind(sender)
    .bind(recipient)
    .execute(&state.pool)
    .await?;

    let notify = json!({ "type": "share.request", "from_user_id": sender }).to_string();
    if state.hub.is_online(recipient) {
        state.hub.send_to_user(recipient, &notify);
    } else {
        tokio::spawn(crate::push::wake_user(
            state.pool.clone(),
            recipient.to_string(),
            crate::push::Wake::new("share_request"),
            state.config.federation_allow_private,
        ));
    }
    Ok(json!({ "ok": true }))
}

/// `share.accept`: a remote user accepts a share the LOCAL user asked them for.
/// Anti-forgery: a matching local(recipient) -> sender *pending outbound*
/// request must exist, else the accept is forged and rejected.
async fn handle_share_accept(
    state: &AppState,
    sender: &str,
    recipient: &str,
    payload: &Value,
) -> ApiResult<Value> {
    // A matching pending outbound request must already exist.
    let pending: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM share_requests
         WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'
         LIMIT 1",
    )
    .bind(recipient)
    .bind(sender)
    .fetch_optional(&state.pool)
    .await?;
    if pending.is_none() {
        tracing::warn!(sender = %sender, recipient = %recipient, "federation: forged share.accept (no pending outbound request) — rejecting");
        return Err(AppError::Forbidden);
    }

    ensure_federated_user(&state.pool, sender).await?;
    // Pin defensively if the accept carries an identity key.
    if let Some(key_hash) = identity_key_hash(payload) {
        tofu_pin(&state.pool, recipient, sender, &key_hash).await?;
    }

    let mut tx = state.pool.begin().await?;
    // Re-check-and-accept atomically (guards against a racing double-accept).
    let accepted: Option<(i32,)> = sqlx::query_as(
        "UPDATE share_requests SET status = 'accepted', updated_at = now()
         WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'
         RETURNING 1",
    )
    .bind(recipient)
    .bind(sender)
    .fetch_optional(&mut *tx)
    .await?;
    if accepted.is_none() {
        return Err(AppError::Forbidden);
    }
    let (lo, hi) = if sender < recipient {
        (sender, recipient)
    } else {
        (recipient, sender)
    };
    sqlx::query("INSERT INTO user_shares (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(lo)
        .bind(hi)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let notify = json!({ "type": "share.accepted", "user_id": sender }).to_string();
    if state.hub.is_online(recipient) {
        state.hub.send_to_user(recipient, &notify);
    } else {
        // The local requester is offline: wake them, symmetric with the local
        // accept path and the federated request path.
        tokio::spawn(crate::push::wake_user(
            state.pool.clone(),
            recipient.to_string(),
            crate::push::Wake::new("share_accepted"),
            state.config.federation_allow_private,
        ));
    }
    Ok(json!({ "ok": true }))
}

/// `mls.key_request`: a remote server asks for one of a LOCAL user's one-time
/// KeyPackages (to add them to a cross-server MLS group). A consented
/// relationship is required (pending/accepted request or an existing share);
/// consumption is the same one-time logic as `api/mls.rs::claim_key` (D-007).
async fn handle_key_request(
    state: &AppState,
    sender: &str,
    recipient: &str,
    payload: &Value,
) -> ApiResult<Value> {
    let key_hash = identity_key_hash(payload).ok_or_else(|| {
        AppError::BadRequest("mls.key_request: missing/invalid identity_key".into())
    })?;

    ensure_federated_user(&state.pool, sender).await?;
    tofu_pin(&state.pool, recipient, sender, &key_hash).await?;

    // Consent gate — the SAME standard as the local `can_fetch_key_packages`
    // (accepted share / active temp share / shared group). A bare *pending*
    // request must NOT grant this: it's unilateral, so honoring it would let a
    // hostile remote (which can mint a pending request via share.request) drain
    // a local user's one-time KeyPackage pool — the D-007 failure mode, across
    // federation. The legit flow accepts the share first, so this still passes.
    if !authz::can_fetch_key_packages(&state.pool, sender, recipient).await? {
        return Err(AppError::Forbidden);
    }

    // Atomically consume one one-time package; fall back to the last-resort
    // package (not consumed) only when the pool is dry (D-007).
    let consumed: Option<(Vec<u8>,)> = sqlx::query_as(
        "UPDATE key_packages SET consumed_at = now()
         WHERE id = (
             SELECT id FROM key_packages
             WHERE user_id = $1 AND consumed_at IS NULL AND NOT is_last_resort
             ORDER BY created_at, id
             LIMIT 1
             FOR UPDATE SKIP LOCKED
         )
         RETURNING key_package",
    )
    .bind(recipient)
    .fetch_optional(&state.pool)
    .await?;

    let (kp, last_resort) = match consumed {
        Some((kp,)) => (kp, false),
        None => {
            let lr: Option<(Vec<u8>,)> = sqlx::query_as(
                "SELECT key_package FROM key_packages WHERE user_id = $1 AND is_last_resort",
            )
            .bind(recipient)
            .fetch_optional(&state.pool)
            .await?;
            match lr {
                Some((kp,)) => (kp, true),
                None => return Err(AppError::NotFound),
            }
        }
    };
    Ok(json!({ "key_package": BASE64.encode(kp), "last_resort": last_resort }))
}

/// `mls.welcome` / `mls.commit`: store an opaque MLS ciphertext into the LOCAL
/// recipient's mailbox and live-push it. Pure ciphertext relay.
async fn handle_mls_relay(
    state: &AppState,
    sender: &str,
    recipient: &str,
    payload: &Value,
    kind: &str,
) -> ApiResult<Value> {
    let group_id = payload
        .get("group_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("missing group_id".into()))?;
    validate_group_id(group_id)?;
    let ct = payload
        .get("ciphertext")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("missing ciphertext".into()))?;
    let blob = BASE64
        .decode(ct)
        .map_err(|_| AppError::BadRequest("ciphertext: invalid base64".into()))?;
    if blob.is_empty() || blob.len() > MAX_MLS_PAYLOAD_BYTES {
        return Err(AppError::BadRequest("ciphertext: invalid size".into()));
    }

    // The mailbox row references the sender by id; ensure the shadow exists.
    ensure_federated_user(&state.pool, sender).await?;

    // Consent gate (matches the local send_welcome/commit path): only relay MLS
    // group material from a remote the recipient actually has a relationship
    // with — otherwise any signed remote could inject unsolicited Welcomes and
    // fill the mailbox.
    if !authz::can_fetch_key_packages(&state.pool, sender, recipient).await? {
        return Err(AppError::Forbidden);
    }

    let mut tx = state.pool.begin().await?;
    let (id, created_at) =
        insert_mailbox(&mut tx, sender, recipient, kind, group_id, &blob).await?;
    tx.commit().await?;
    push_mailbox(
        state, id, created_at, sender, recipient, kind, group_id, &blob,
    );
    Ok(json!({ "id": id, "ok": true }))
}

/// `location.update`: relay a cross-server group's MLS ciphertext to the LOCAL
/// recipient's live connections. Fail-closed: a fix from the remote `sender`
/// may reach the local `recipient` only on a current relationship and when the
/// SENDER isn't ghosting the recipient — `can_deliver_to_user(sender, recipient)`
/// is exactly that (sender-first, matching the local WS path). CIPHERTEXT ONLY —
/// the base64 blob is re-emitted verbatim, only decoded to bound its size.
async fn handle_location_update(
    state: &AppState,
    sender: &str,
    recipient: &str,
    payload: &Value,
) -> ApiResult<Value> {
    let ct = payload
        .get("ciphertext")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("location.update: missing ciphertext".into()))?;
    let blob = BASE64
        .decode(ct)
        .map_err(|_| AppError::BadRequest("ciphertext: invalid base64".into()))?;
    if blob.is_empty() || blob.len() > MAX_LOCATION_BLOB_BYTES {
        return Err(AppError::BadRequest("ciphertext: invalid size".into()));
    }
    let ts = payload
        .get("timestamp")
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| Utc::now().timestamp_millis());

    // Fail-closed authz (errors deny). No relationship / ghosting = silent drop.
    let allowed = authz::can_deliver_to_user(&state.pool, sender, recipient).await?;
    if allowed {
        let out = json!({
            "type": "location.broadcast",
            "sender_id": sender,
            "recipient_type": "user",
            "recipient_id": recipient,
            "blob": ct,
            "timestamp": ts,
        })
        .to_string();
        state.hub.send_to_user(recipient, &out);
    } else {
        tracing::debug!(sender = %sender, recipient = %recipient, "federated location.update dropped (authz)");
    }
    Ok(json!({ "ok": true, "delivered": allowed }))
}

// ---------------------------------------------------------------------------
// outbound (authenticated local user drives cross-server traffic)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SendBody {
    /// Full remote recipient id, `name@remote_domain`.
    pub recipient: String,
    pub message_type: String,
    #[serde(default)]
    pub payload: Value,
}

/// POST /api/federation/send — the authenticated local user sends a signed
/// FederatedMessage to a remote domain. We build the envelope (sender = caller),
/// sign the EXACT bytes we will transmit, SSRF-check + discover the remote
/// inbox, POST it, and return the remote's response.
pub async fn send(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<SendBody>,
) -> ApiResult<Json<Value>> {
    let value = send_federated(
        &state,
        &user.user_id,
        &body.recipient,
        &body.message_type,
        body.payload,
    )
    .await?;
    Ok(Json(value))
}

pub(crate) async fn send_federated(
    state: &AppState,
    sender: &str,
    recipient: &str,
    message_type: &str,
    payload: Value,
) -> ApiResult<Value> {
    let recipient = recipient.trim().to_lowercase();
    let remote_domain = domain_of(&recipient)
        .ok_or_else(|| AppError::BadRequest("recipient has no domain".into()))?
        .to_string();
    if remote_domain.eq_ignore_ascii_case(&state.config.domain) {
        return Err(AppError::BadRequest(
            "recipient is local; use the local API".into(),
        ));
    }
    if !is_federatable_type(message_type) {
        return Err(AppError::BadRequest("unknown message_type".into()));
    }

    // When WE initiate a cross-server share, record the outbound pending
    // locally (ensuring the remote shadow exists for the FK), so the peer's
    // later `share.accept` passes our anti-forgery check. Mirrors what the
    // remote does on receiving our share.request.
    if message_type == "share.request" {
        ensure_federated_user(&state.pool, &recipient).await?;
        sqlx::query(
            "INSERT INTO share_requests (from_user_id, to_user_id) VALUES ($1, $2)
             ON CONFLICT (from_user_id, to_user_id)
             DO UPDATE SET status = 'pending', updated_at = now()
             WHERE share_requests.status <> 'pending'",
        )
        .bind(sender)
        .bind(&recipient)
        .execute(&state.pool)
        .await?;
    }

    let msg = FederatedMessage {
        sender: sender.to_string(),
        recipient,
        message_type: message_type.to_string(),
        payload,
        timestamp: Utc::now().timestamp(),
    };
    // Sign the exact bytes we send — the peer verifies these same bytes.
    let raw = serde_json::to_vec(&msg)
        .map_err(|e| AppError::Internal(format!("serialize federated message: {e}")))?;
    let sig = federation_keys::sign(&state.server_signing_key, &raw);

    let (status, value) = deliver(state, &remote_domain, &raw, &sig).await?;
    Ok(json!({ "status": status, "response": value }))
}

#[derive(Deserialize)]
pub struct VerifyBody {
    pub remote_user_id: String,
}

/// POST /api/federation/verify — the out-of-band (SAS/QR) confirm: mark the pin
/// for (caller, remote_user_id) verified. A pin must already exist (a remote we
/// have actually been in contact with), else 404.
pub async fn verify_pin(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<VerifyBody>,
) -> ApiResult<Json<Value>> {
    let remote = body.remote_user_id.trim().to_lowercase();
    if remote.is_empty() {
        return Err(AppError::BadRequest("invalid remote_user_id".into()));
    }
    let res = sqlx::query(
        "UPDATE federation_pins SET verified = TRUE
         WHERE local_user_id = $1 AND remote_user_id = $2",
    )
    .bind(&user.user_id)
    .bind(&remote)
    .execute(&state.pool)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(
        json!({ "ok": true, "remote_user_id": remote, "verified": true }),
    ))
}

// ---------------------------------------------------------------------------
// S2S HTTP client (rustls) + SSRF guard
// ---------------------------------------------------------------------------

/// Build a client that PINS the connection to the already-validated IPs
/// (`addrs`), so the connector cannot re-resolve DNS to a different, internal
/// address between our SSRF check and the connect (TOCTOU / DNS-rebinding).
/// When `addrs` is empty (allow-private dev/test) no pin is set and normal
/// resolution is used.
fn build_client(pin_host: &str, addrs: &[std::net::SocketAddr]) -> ApiResult<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .timeout(S2S_TIMEOUT)
        // Never follow redirects: a 3xx to an internal host would bypass the
        // SSRF check + pin we applied to the original target.
        .redirect(reqwest::redirect::Policy::none());
    if !addrs.is_empty() {
        b = b.resolve_to_addrs(pin_host, addrs);
    }
    b.build()
        .map_err(|e| AppError::Internal(format!("http client: {e}")))
}

/// Scheme+authority for a peer. Plain http only in the allow-private (dev/test)
/// mode so the localhost integration test can talk to `127.0.0.1:PORT`.
fn peer_base(domain: &str, allow_private: bool) -> String {
    let scheme = if allow_private { "http" } else { "https" };
    format!("{scheme}://{domain}")
}

/// The bare hostname (no port) — the key reqwest resolves and we pin.
fn host_only(domain: &str) -> &str {
    domain.rsplit_once(':').map_or(domain, |(h, _)| h)
}

/// Fetch and parse a peer's `/.well-known/point`, pinning the connection to the
/// SSRF-validated IPs.
async fn discover(domain: &str, allow_private: bool) -> ApiResult<RemoteWellKnown> {
    let addrs = ssrf_check(domain, allow_private).await?;
    let url = format!("{}/.well-known/point", peer_base(domain, allow_private));
    let client = build_client(host_only(domain), &addrs)?;
    let resp = client.get(&url).send().await.map_err(|e| {
        tracing::warn!(domain = %domain, error = %e, "federation: discovery request failed");
        AppError::Internal("discovery failed".into())
    })?;
    if !resp.status().is_success() {
        return Err(AppError::Internal("discovery returned non-2xx".into()));
    }
    resp.json::<RemoteWellKnown>().await.map_err(|e| {
        tracing::warn!(domain = %domain, error = %e, "federation: discovery parse failed");
        AppError::Internal("discovery parse failed".into())
    })
}

/// SSRF-check + discover + POST the signed body to the remote inbox. Returns the
/// remote's (status code, JSON body).
async fn deliver(
    state: &AppState,
    remote_domain: &str,
    raw: &[u8],
    sig: &str,
) -> ApiResult<(u16, Value)> {
    let allow_private = state.config.federation_allow_private;
    // discover() SSRF-checks + pins the discovery connection itself.
    let peer = discover(remote_domain, allow_private).await?;

    // The advertised inbox host could differ from the domain — SSRF-check it too
    // and pin the POST connection to its validated IPs.
    let Some(inbox_host) = inbox_host(&peer.endpoints.inbox) else {
        return Err(AppError::Internal(
            "peer advertised an invalid inbox URL".into(),
        ));
    };
    let inbox_addrs = ssrf_check(&inbox_host, allow_private).await?;

    let client = build_client(host_only(&inbox_host), &inbox_addrs)?;
    let resp = client
        .post(&peer.endpoints.inbox)
        .header("x-point-signature", sig)
        .header("x-point-origin", &state.config.domain)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(raw.to_vec())
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(domain = %remote_domain, error = %e, "federation: inbox POST failed");
            AppError::Internal("federation delivery failed".into())
        })?;
    let status = resp.status().as_u16();
    let value = resp.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, value))
}

/// Host component of an inbox URL (for the secondary SSRF check).
fn inbox_host(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
}

/// Reject an outbound target that resolves to (or is) a non-public address.
/// When `allow_private` is set (dev/test), the whole check is skipped so the
/// integration test can reach `127.0.0.1`.
/// SSRF guard. Resolves the host and rejects if ANY resolved IP is
/// non-public, returning the validated `SocketAddr`s so the caller can PIN the
/// connection to exactly these (no re-resolution → no DNS-rebinding TOCTOU).
/// Returns an empty vec in allow-private (dev/test) mode (no pin, no check).
pub async fn ssrf_check(domain: &str, allow_private: bool) -> ApiResult<Vec<std::net::SocketAddr>> {
    if allow_private {
        return Ok(Vec::new());
    }
    // Strip an optional `:port`. (An IPv6 literal is caught by the denylist
    // before this could mangle it.)
    let host = domain.rsplit_once(':').map_or(domain, |(h, _)| h);
    if hostname_denied(host) {
        tracing::warn!(host = %host, "SSRF: hostname on denylist — rejecting");
        return Err(AppError::Forbidden);
    }
    // Resolve and inspect EVERY IP. Resolution failure or an empty answer denies
    // (fail closed).
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host(format!("{host}:443"))
        .await
        .map_err(|e| {
            tracing::warn!(host = %host, error = %e, "SSRF: DNS resolution failed — rejecting");
            AppError::Forbidden
        })?
        .collect();
    if addrs.is_empty() {
        return Err(AppError::Forbidden);
    }
    for addr in &addrs {
        if ip_disallowed(addr.ip()) {
            tracing::warn!(host = %host, ip = %addr.ip(), "SSRF: resolved to a non-public IP — rejecting");
            return Err(AppError::Forbidden);
        }
    }
    Ok(addrs)
}

/// Hostname-string denylist (independent of DNS): localhost, mDNS/`.local`,
/// `.internal`, the cloud metadata host, and bare IP literals.
pub fn hostname_denied(host: &str) -> bool {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() {
        return true;
    }
    if h == "localhost"
        || h == "metadata.google.internal"
        || h.ends_with(".local")
        || h.ends_with(".internal")
        || h.ends_with(".localhost")
    {
        return true;
    }
    // A bare IP literal (v4/v6, with or without brackets) must go through the
    // resolved-IP path conceptually; deny it here so `http://10.0.0.1` etc can't
    // slip past DNS entirely.
    let unbracketed = h.trim_start_matches('[').trim_end_matches(']');
    unbracketed.parse::<IpAddr>().is_ok()
}

/// Is this resolved IP one we must never make an S2S request to?
pub fn ip_disallowed(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_documentation()
                || is_shared_cgnat_v4(v4)
        }
        IpAddr::V6(v6) => {
            // An IPv4-mapped address is really the embedded v4 address.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return ip_disallowed(IpAddr::V4(mapped));
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || is_ula_v6(v6)
                || is_link_local_v6(v6)
        }
    }
}

/// 100.64.0.0/10 — carrier-grade NAT shared address space.
fn is_shared_cgnat_v4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    o[0] == 100 && (o[1] & 0xc0) == 0x40
}

/// fc00::/7 — unique local addresses.
fn is_ula_v6(v6: Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xfe00) == 0xfc00
}

/// fe80::/10 — link-local unicast.
fn is_link_local_v6(v6: Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xffc0) == 0xfe80
}

/// Is `ts` within ±[`REPLAY_WINDOW_SECS`] of `now` (both epoch seconds)?
pub fn replay_ok(ts: i64, now: i64) -> bool {
    (now - ts).abs() <= REPLAY_WINDOW_SECS
}

// ---------------------------------------------------------------------------
// small helpers / DB
// ---------------------------------------------------------------------------

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Domain component of a `name@domain` id.
pub(crate) fn domain_of(user_id: &str) -> Option<&str> {
    user_id
        .rsplit_once('@')
        .map(|(_, d)| d)
        .filter(|d| !d.is_empty())
}

fn local_part(user_id: &str) -> &str {
    user_id.split('@').next().unwrap_or(user_id)
}

fn is_federatable_type(t: &str) -> bool {
    matches!(
        t,
        "share.request"
            | "share.accept"
            | "share.remove"
            | "profile.updated"
            | "mls.key_request"
            | "mls.welcome"
            | "mls.commit"
            | "location.update"
    )
}

/// SHA-256 (hex) of the payload's base64 `identity_key`. `None` if absent or
/// malformed — pinning operations require a key.
fn identity_key_hash(payload: &Value) -> Option<String> {
    let ik = payload.get("identity_key").and_then(|v| v.as_str())?;
    let bytes = BASE64.decode(ik).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_IDENTITY_KEY_BYTES {
        return None;
    }
    Some(hex::encode(Sha256::digest(&bytes)))
}

/// Create a federated shadow user (is_federated, no password) + their person
/// entity, once. Never clobbers an existing (possibly local) row.
pub async fn ensure_federated_user(pool: &sqlx::PgPool, user_id: &str) -> ApiResult<()> {
    let display = local_part(user_id);
    let mut tx = pool.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO users (id, display_name, is_federated) VALUES ($1, $2, TRUE)
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(user_id)
    .bind(display)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 1 {
        sqlx::query(
            "INSERT INTO entities (kind, owner_id, display_name) VALUES ('person', $1, $2)",
        )
        .bind(user_id)
        .bind(display)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// TOFU-pin: first contact stores the remote's identity-key hash; a later
/// contact whose hash DIFFERS is a loud, fail-closed [`AppError::Forbidden`]
/// (the forced-re-verify signal).
pub async fn tofu_pin(
    pool: &sqlx::PgPool,
    local_user_id: &str,
    remote_user_id: &str,
    key_hash: &str,
) -> ApiResult<()> {
    // Atomically resolve the EFFECTIVE pinned key in one round-trip: insert on
    // first contact, and on conflict return the value already stored. Doing the
    // SELECT and INSERT as separate statements let two concurrent first-contacts
    // with DIFFERENT keys both observe "no pin" and both return Ok — the loser's
    // key silently disagreeing with what got stored (LOW-1). Here the loser gets
    // the winner's row back and the compare below rejects the mismatch.
    let (effective,): (String,) = sqlx::query_as(
        "WITH ins AS (
             INSERT INTO federation_pins (local_user_id, remote_user_id, key_hash)
             VALUES ($1, $2, $3)
             ON CONFLICT (local_user_id, remote_user_id) DO NOTHING
             RETURNING key_hash
         )
         SELECT key_hash FROM ins
         UNION ALL
         SELECT key_hash FROM federation_pins
           WHERE local_user_id = $1 AND remote_user_id = $2
         LIMIT 1",
    )
    .bind(local_user_id)
    .bind(remote_user_id)
    .bind(key_hash)
    .fetch_one(pool)
    .await?;

    if effective != key_hash {
        tracing::warn!(
            local_user_id = %local_user_id,
            remote_user_id = %remote_user_id,
            "federation: remote identity key CHANGED from the pinned value — REJECTING (forced re-verify)"
        );
        return Err(AppError::Forbidden);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
