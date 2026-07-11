//! WebSocket transport: live location stream (JSON frames carrying MLS
//! ciphertext). Auth is the first message, never in the URL (D-011: the same
//! `auth::validate_token` as REST, full revocation check). Every delivery
//! decision goes through `authz` and fails closed: an authz error or deny is a
//! silent drop, never an error frame that would leak relationship state.

pub mod hub;

use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::mpsc::{self, UnboundedSender};
use uuid::Uuid;

use crate::auth;
use crate::authz;
use crate::state::AppState;

/// First-message auth deadline. Prod keeps the legacy 5s; tests shrink it so
/// the timeout path can be exercised without stalling the suite.
#[cfg(not(test))]
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const AUTH_TIMEOUT: Duration = Duration::from_millis(500);

/// Live fixes expire after this many seconds (reaped by the cleanup task).
const LIVE_FIX_TTL_SECS: i32 = 300;
/// A single encrypted fix is small; 16KB decoded is already generous.
const MAX_LOCATION_BLOB_BYTES: usize = 16 * 1024;
/// Max items per `location.batch_update`.
const MAX_BATCH_ITEMS: usize = 50;
/// Inbound frame cap: a full 50-item batch of max-size blobs in base64.
const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

/// GET /ws — upgrade after the browser-origin guard. A present Origin header
/// must match this server (or a localhost dev origin); a missing Origin
/// (native apps) is allowed.
pub async fn ws_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if let Some(origin) = headers.get(header::ORIGIN) {
        let allowed = origin
            .to_str()
            .map(|o| {
                o == format!("https://{}", state.config.domain)
                    || o == "http://localhost:3000"
                    || o == "http://localhost:8080"
            })
            .unwrap_or(false);
        if !allowed {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(state, socket))
}

#[derive(Deserialize)]
struct AuthFrame {
    #[serde(rename = "type")]
    typ: String,
    #[serde(default)]
    token: String,
}

/// Inbound frame envelope. Unknown fields are ignored; unknown types are
/// answered with an error frame but keep the connection.
#[derive(Deserialize)]
struct Frame {
    #[serde(rename = "type")]
    typ: String,
    recipient_type: Option<String>,
    recipient_id: Option<String>,
    /// Base64 MLS ciphertext — opaque to the server.
    blob: Option<String>,
    /// Batch of fixes for `location.batch_update`.
    blobs: Option<Vec<BatchItem>>,
    /// Sender-claimed epoch millis (opaque metadata).
    timestamp: Option<i64>,
    battery: Option<Value>,
    activity: Option<Value>,
    target_user_id: Option<String>,
}

#[derive(Deserialize)]
struct BatchItem {
    recipient_type: String,
    recipient_id: String,
    blob: String,
    timestamp: i64,
}

async fn handle_socket(state: AppState, mut socket: WebSocket) {
    // Auth-as-first-message: full validation (signature + expiry + revocation),
    // the exact same path REST uses. Anything else closes quietly.
    let user = match tokio::time::timeout(AUTH_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<AuthFrame>(&text) {
            Ok(f) if f.typ == "auth" => auth::validate_token(&state, &f.token).await.ok(),
            _ => None,
        },
        _ => None,
    };
    let Some(user) = user else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    let user_id = user.user_id;

    let (tx, mut rx) = mpsc::unbounded_channel::<hub::Outbound>();
    let reply = tx.clone();
    let conn_id = state.hub.add_connection(&user_id, tx);

    let (mut sink, mut stream) = socket.split();
    let ok = json!({ "type": "auth.ok", "user_id": user_id }).to_string();
    if sink.send(Message::Text(ok.into())).await.is_err() {
        state.hub.remove_connection(&user_id, conn_id);
        return;
    }

    // Presence: online, to everyone entitled to see the sender's presence.
    broadcast_presence(&state, &user_id, true, None, None).await;

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let mut limiter = ConnLimiter::default();
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                handle_frame(&state, &user_id, &mut limiter, &reply, text.as_str()).await;
            }
            Message::Close(_) => break,
            // Ping/pong are answered by the transport; binary frames ignored.
            _ => {}
        }
    }

    state.hub.remove_connection(&user_id, conn_id);
    writer.abort();
    // Presence: offline — but only once the user's LAST device is gone.
    if !state.hub.is_online(&user_id) {
        broadcast_presence(&state, &user_id, false, None, None).await;
    }
}

// ---------------------------------------------------------------------------
// per-connection rate limiting
// ---------------------------------------------------------------------------

/// Fixed 60s windows per traffic class; state lives and dies with the
/// connection, so there is nothing to GC.
#[derive(Default)]
struct ConnLimiter {
    windows: HashMap<&'static str, (u64, u32)>,
}

impl ConnLimiter {
    fn allow(&mut self, class: &'static str, limit: u32) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let window = now / 60;
        let entry = self.windows.entry(class).or_insert((window, 0));
        if entry.0 != window {
            *entry = (window, 0);
        }
        entry.1 += 1;
        entry.1 <= limit
    }
}

// ---------------------------------------------------------------------------
// frame dispatch
// ---------------------------------------------------------------------------

async fn handle_frame(
    state: &AppState,
    sender: &str,
    limiter: &mut ConnLimiter,
    reply: &UnboundedSender<String>,
    text: &str,
) {
    let Ok(frame) = serde_json::from_str::<Frame>(text) else {
        send_error(reply, "invalid frame");
        return;
    };
    let (class, limit) = match frame.typ.as_str() {
        "location.update" | "location.batch_update" => ("location", 60),
        "location.nudge" => ("nudge", 10),
        "presence.update" => ("presence", 30),
        _ => ("other", 120),
    };
    if !limiter.allow(class, limit) {
        send_error(reply, "rate limited");
        return;
    }
    match frame.typ.as_str() {
        "location.update" => on_location_update(state, sender, reply, frame).await,
        "location.batch_update" => on_batch_update(state, sender, reply, frame).await,
        "presence.update" => {
            broadcast_presence(
                state,
                sender,
                true,
                frame.battery.as_ref(),
                frame.activity.as_ref(),
            )
            .await;
        }
        "location.nudge" => on_nudge(state, sender, reply, frame).await,
        _ => send_error(reply, "unknown type"),
    }
}

fn send_error(reply: &UnboundedSender<String>, error: &str) {
    let _ = reply.send(json!({ "type": "error", "error": error }).to_string());
}

// ---------------------------------------------------------------------------
// location.update / location.batch_update
// ---------------------------------------------------------------------------

async fn on_location_update(
    state: &AppState,
    sender: &str,
    reply: &UnboundedSender<String>,
    frame: Frame,
) {
    let (Some(rtype), Some(rid), Some(blob_b64)) =
        (frame.recipient_type, frame.recipient_id, frame.blob)
    else {
        send_error(reply, "invalid frame");
        return;
    };
    let Some(blob) = decode_blob(&blob_b64) else {
        send_error(reply, "invalid frame");
        return;
    };
    let ts = frame
        .timestamp
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    // Fail-closed gate; deny and error are both a silent drop (no relationship
    // oracle over the socket).
    let Some(recipients) = allowed_recipients(&state.pool, sender, &rtype, &rid).await else {
        tracing::debug!(sender, "location.update dropped (authz)");
        return;
    };
    let Some(entity) = sender_entity(&state.pool, sender).await else {
        return;
    };
    if let Err(e) = insert_history(&state.pool, entity, &rtype, &rid, &blob, ts).await {
        tracing::error!(error = %e, "location history insert failed");
        return; // do not broadcast what we could not record
    }
    if let Err(e) = store_live_fix(&state.pool, entity, &rtype, &rid, &blob, ts).await {
        tracing::error!(error = %e, "live fix store failed");
        return;
    }
    broadcast_fix(state, sender, &rtype, &rid, &blob_b64, ts, &recipients);
}

async fn on_batch_update(
    state: &AppState,
    sender: &str,
    reply: &UnboundedSender<String>,
    frame: Frame,
) {
    let Some(items) = frame.blobs else {
        send_error(reply, "invalid frame");
        return;
    };
    if items.is_empty() || items.len() > MAX_BATCH_ITEMS {
        send_error(reply, "invalid frame");
        return;
    }
    let Some(entity) = sender_entity(&state.pool, sender).await else {
        return;
    };

    // Authz once per audience, not per item.
    let mut authz_cache: HashMap<(String, String), Option<Vec<String>>> = HashMap::new();
    // Newest fix per audience: only that one hits location_updates + the wire.
    let mut newest: HashMap<(String, String), (i64, String)> = HashMap::new();

    for item in items {
        let key = (item.recipient_type.clone(), item.recipient_id.clone());
        if !authz_cache.contains_key(&key) {
            let decision = allowed_recipients(&state.pool, sender, &key.0, &key.1).await;
            authz_cache.insert(key.clone(), decision);
        }
        if authz_cache.get(&key).and_then(|d| d.as_ref()).is_none() {
            tracing::debug!(sender, "batch item dropped (authz)");
            continue;
        }
        let Some(blob) = decode_blob(&item.blob) else {
            continue;
        };
        // Every allowed fix lands in history; only the newest goes live.
        if let Err(e) =
            insert_history(&state.pool, entity, &key.0, &key.1, &blob, item.timestamp).await
        {
            tracing::error!(error = %e, "location history insert failed");
            continue;
        }
        let newer = newest.get(&key).is_none_or(|(t, _)| item.timestamp > *t);
        if newer {
            newest.insert(key, (item.timestamp, item.blob));
        }
    }

    for ((rtype, rid), (ts, blob_b64)) in newest {
        let Some(Some(recipients)) = authz_cache.get(&(rtype.clone(), rid.clone())) else {
            continue; // unreachable: only allowed audiences reach `newest`
        };
        let Some(blob) = decode_blob(&blob_b64) else {
            continue;
        };
        if let Err(e) = store_live_fix(&state.pool, entity, &rtype, &rid, &blob, ts).await {
            tracing::error!(error = %e, "live fix store failed");
            continue;
        }
        broadcast_fix(state, sender, &rtype, &rid, &blob_b64, ts, recipients);
    }
}

fn decode_blob(b64: &str) -> Option<Vec<u8>> {
    let blob = BASE64.decode(b64).ok()?;
    (!blob.is_empty() && blob.len() <= MAX_LOCATION_BLOB_BYTES).then_some(blob)
}

/// Who may receive this fix? `None` = drop (deny, unknown audience kind, or a
/// DB error — errors deny, D-005). `Some(list)` never includes the sender;
/// their own devices are added at broadcast time.
async fn allowed_recipients(
    pool: &PgPool,
    sender: &str,
    recipient_type: &str,
    recipient_id: &str,
) -> Option<Vec<String>> {
    let decision = match recipient_type {
        "user" => authz::can_deliver_to_user(pool, sender, recipient_id)
            .await
            .map(|ok| ok.then(|| vec![recipient_id.to_string()])),
        "group" => {
            // Pre-validate the uuid so bad input never reaches a ::uuid cast.
            if Uuid::parse_str(recipient_id).is_err() {
                return None;
            }
            authz::group_fanout_recipients(pool, sender, recipient_id)
                .await
                .map(|members| (!members.is_empty()).then_some(members))
        }
        _ => return None,
    };
    match decision {
        Ok(allowed) => allowed,
        Err(e) => {
            tracing::warn!(error = %e, "authz error — dropping delivery (fail closed)");
            None
        }
    }
}

/// The sender's person entity, created at registration. Missing = corrupted
/// account state; fail closed by dropping the fix.
async fn sender_entity(pool: &PgPool, user_id: &str) -> Option<Uuid> {
    let row: Result<Option<(Uuid,)>, _> =
        sqlx::query_as("SELECT id FROM entities WHERE owner_id = $1 AND kind = 'person'")
            .bind(user_id)
            .fetch_optional(pool)
            .await;
    match row {
        Ok(Some((id,))) => Some(id),
        Ok(None) => {
            tracing::warn!(user_id, "no person entity — dropping fix (fail closed)");
            None
        }
        Err(e) => {
            tracing::error!(error = %e, "entity lookup failed — dropping fix");
            None
        }
    }
}

/// Replace the live fix for (sender entity, audience): one current row each.
async fn store_live_fix(
    pool: &PgPool,
    entity: Uuid,
    rtype: &str,
    rid: &str,
    blob: &[u8],
    ts: i64,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "DELETE FROM location_updates
         WHERE sender_entity_id = $1 AND recipient_type = $2 AND recipient_id = $3",
    )
    .bind(entity)
    .bind(rtype)
    .bind(rid)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO location_updates
             (sender_entity_id, recipient_type, recipient_id, encrypted_blob,
              client_timestamp, ttl_seconds)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(entity)
    .bind(rtype)
    .bind(rid)
    .bind(blob)
    .bind(ts)
    .bind(LIVE_FIX_TTL_SECS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

async fn insert_history(
    pool: &PgPool,
    entity: Uuid,
    rtype: &str,
    rid: &str,
    blob: &[u8],
    ts: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO location_history
             (entity_id, recipient_type, recipient_id, encrypted_blob, client_timestamp)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(entity)
    .bind(rtype)
    .bind(rid)
    .bind(blob)
    .bind(ts)
    .execute(pool)
    .await
    .map(|_| ())
}

fn broadcast_fix(
    state: &AppState,
    sender: &str,
    rtype: &str,
    rid: &str,
    blob_b64: &str,
    ts: i64,
    recipients: &[String],
) {
    let out = json!({
        "type": "location.broadcast",
        "sender_id": sender,
        "recipient_type": rtype,
        "recipient_id": rid,
        "blob": blob_b64,
        "timestamp": ts,
    })
    .to_string();
    // Recipients + the sender's own other devices, deduped.
    let mut targets: HashSet<&str> = recipients.iter().map(String::as_str).collect();
    targets.insert(sender);
    for t in targets {
        state.hub.send_to_user(t, &out);
    }
}

// ---------------------------------------------------------------------------
// presence
// ---------------------------------------------------------------------------

/// Broadcast presence to every group co-member and accepted-share partner,
/// deduped, ghost-filtered (global ghost drops everything; per-target ghost
/// drops that target). Fail closed: an audience query error broadcasts nothing.
async fn broadcast_presence(
    state: &AppState,
    user_id: &str,
    online: bool,
    battery: Option<&Value>,
    activity: Option<&Value>,
) {
    let audience = match presence_audience(&state.pool, user_id).await {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!(error = %e, "presence audience query failed — dropping");
            return;
        }
    };
    if audience.is_empty() {
        return;
    }
    let mut msg = json!({
        "type": "presence.update",
        "user_id": user_id,
        "online": online,
    });
    if let Some(b) = battery {
        msg["battery"] = b.clone();
    }
    if let Some(a) = activity {
        msg["activity"] = a.clone();
    }
    let msg = msg.to_string();
    state.hub.send_to_users(audience.iter(), &msg);
}

async fn presence_audience(pool: &PgPool, user_id: &str) -> Result<Vec<String>, sqlx::Error> {
    if authz::is_globally_ghosted(pool, user_id).await? {
        return Ok(Vec::new());
    }
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT aud FROM (
             SELECT other.user_id AS aud
             FROM group_members mine
             JOIN group_members other ON other.group_id = mine.group_id
             WHERE mine.user_id = $1 AND other.user_id <> $1
             UNION
             SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END
             FROM user_shares WHERE user_a = $1 OR user_b = $1
         ) s
         WHERE NOT EXISTS (
             SELECT 1 FROM ghost_targets gt
             WHERE gt.user_id = $1 AND gt.target_user_id = aud
         )",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(u,)| u).collect())
}

// ---------------------------------------------------------------------------
// nudge
// ---------------------------------------------------------------------------

/// The viewer asks the target's devices to wake and send a fresh fix. Allowed
/// only when the VIEWER may currently see the TARGET (can_view). Deny/error =
/// silent drop. (FCM wake for offline targets lands in M1, D-012.)
async fn on_nudge(state: &AppState, sender: &str, reply: &UnboundedSender<String>, frame: Frame) {
    let Some(target) = frame.target_user_id else {
        send_error(reply, "invalid frame");
        return;
    };
    let target = target.trim().to_lowercase();
    match authz::can_view(&state.pool, sender, &target).await {
        Ok(true) => {
            let out = json!({ "type": "location.nudge", "from": sender }).to_string();
            state.hub.send_to_user(&target, &out);
        }
        Ok(false) => tracing::debug!(sender, "nudge dropped (authz)"),
        Err(e) => tracing::warn!(error = %e, "nudge dropped (authz error)"),
    }
}
