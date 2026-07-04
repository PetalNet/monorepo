//! Minimal Matrix client-server bits: send a text message to the control
//! room; long-poll /sync and extract `!command` strings from it.
//!
//! Threading model (deliberate change from JS): the supervisor NEVER blocks
//! on the network. Outbound messages go through a queue drained by a sender
//! thread; inbound commands come from a sync thread. Every request has a
//! timeout. (manager.js awaited sends inline and its sync had no timeout /
//! no backoff on transport errors — a wedged homeserver could stall
//! supervision or hot-loop the sync. Here supervision keeps running with
//! Matrix fully down.)

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};

use crate::config::MatrixCreds;
use crate::state::epoch_secs;

/// Percent-encode for URL path/query components (RFC 3986 unreserved kept).
pub fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub struct MatrixClient {
    homeserver: String,
    token: String,
    pub user_id: String,
    room: String,
    agent: ureq::Agent,
    txn: AtomicU64,
    sync_token: Option<String>,
}

impl MatrixClient {
    pub fn new(creds: &MatrixCreds, room: &str) -> MatrixClient {
        MatrixClient {
            homeserver: creds.homeserver.trim_end_matches('/').to_string(),
            token: creds.access_token.clone(),
            user_id: creds.user_id.clone(),
            room: room.to_string(),
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(10))
                .build(),
            // Seed the txn counter from wall clock so ids stay unique across
            // manager restarts (JS used Date.now(), which could collide on
            // same-millisecond sends).
            txn: AtomicU64::new(epoch_secs() * 1000),
            sync_token: None,
        }
    }

    /// Returns (status, body). status 0 = transport error (JS parity).
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> (u16, Value) {
        let url = format!("{}{}", self.homeserver, path);
        let req = self
            .agent
            .request(method, &url)
            .set("Authorization", &format!("Bearer {}", self.token))
            .timeout(timeout);
        let result = match body {
            Some(b) => req.send_json(b.clone()),
            None => req.call(),
        };
        match result {
            Ok(resp) => {
                let status = resp.status();
                let v: Value = resp.into_json().unwrap_or(Value::Null);
                (status, v)
            }
            Err(ureq::Error::Status(code, resp)) => {
                let v: Value = resp.into_json().unwrap_or(Value::Null);
                (code, v)
            }
            Err(e) => {
                eprintln!("[manager/matrix] request error: {e}");
                (0, Value::Null)
            }
        }
    }

    pub fn send_text(&self, text: &str) -> bool {
        let txn = self.txn.fetch_add(1, Ordering::SeqCst);
        let path = format!(
            "/_matrix/client/v3/rooms/{}/send/m.room.message/{}",
            urlenc(&self.room),
            txn
        );
        let (status, _) = self.request(
            "PUT",
            &path,
            Some(&json!({ "msgtype": "m.text", "body": text })),
            Duration::from_secs(15),
        );
        (200..300).contains(&status)
    }

    /// One /sync round. Ok(commands) on success; Err(()) on transport failure
    /// or a response with no next_batch (caller backs off).
    ///
    /// Command extraction is JS parity: m.room.message events in the control
    /// room timeline, not sent by us, whose body starts with `!` — returned
    /// stripped of `!`, lowercased, trimmed.
    pub fn sync(&mut self, timeout_ms: u64) -> Result<Vec<String>, ()> {
        let qs = match &self.sync_token {
            Some(tok) => format!(
                "?since={}&timeout={}&filter={}",
                urlenc(tok),
                timeout_ms,
                urlenc(&json!({"room": {"timeline": {"limit": 10}}}).to_string())
            ),
            // First sync: drain without history so stale commands are never
            // re-executed (JS parity: timeout=0, timeline limit 0).
            None => format!(
                "?timeout=0&filter={}",
                urlenc(&json!({"room": {"timeline": {"limit": 0}}}).to_string())
            ),
        };
        let http_timeout = Duration::from_millis(timeout_ms + 15_000);
        let (status, body) =
            self.request("GET", &format!("/_matrix/client/v3/sync{qs}"), None, http_timeout);
        let next = body.get("next_batch").and_then(|v| v.as_str());
        if status == 0 || next.is_none() {
            return Err(());
        }
        self.sync_token = Some(next.unwrap().to_string());

        // JSON-pointer path segments need '/' and '~' escaped per RFC 6901;
        // room ids contain neither, but navigate by key to be safe.
        let events = body
            .get("rooms")
            .and_then(|v| v.get("join"))
            .and_then(|v| v.get(&self.room))
            .and_then(|v| v.get("timeline"))
            .and_then(|v| v.get("events"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let cmds = events
            .iter()
            .filter(|e| {
                e.get("type").and_then(|t| t.as_str()) == Some("m.room.message")
                    && e.get("sender").and_then(|s| s.as_str()) != Some(self.user_id.as_str())
            })
            .filter_map(|e| e.get("content").and_then(|c| c.get("body")).and_then(|b| b.as_str()))
            .map(str::trim)
            .filter(|s| s.starts_with('!'))
            .map(|s| s[1..].to_lowercase().trim().to_string())
            .collect();
        Ok(cmds)
    }
}

/// Outbound queue. The returned Sender never blocks; the thread drains it
/// with per-request timeouts and exits when every Sender is dropped (which
/// flushes the final shutdown message before the process exits).
pub fn spawn_sender(client: MatrixClient) -> (Sender<String>, JoinHandle<()>) {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let handle = std::thread::Builder::new()
        .name("matrix-send".into())
        .spawn(move || {
            for msg in rx {
                if !client.send_text(&msg) {
                    eprintln!("[manager/matrix] send failed (dropped): {msg:?}");
                }
            }
        })
        .expect("spawn matrix-send thread");
    (tx, handle)
}

/// Inbound command loop: initial drain, then 30s long-polls. Transport
/// failures back off 5s. `last_sync_ok` (epoch secs) feeds the heartbeat.
pub fn spawn_command_loop(
    mut client: MatrixClient,
    shutdown: Arc<AtomicBool>,
    last_sync_ok: Arc<AtomicU64>,
) -> Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::Builder::new()
        .name("matrix-sync".into())
        .spawn(move || {
            // Startup drain (JS parity: matrixSync(0) before the loop).
            if client.sync(0).is_ok() {
                last_sync_ok.store(epoch_secs(), Ordering::SeqCst);
            }
            while !shutdown.load(Ordering::SeqCst) {
                match client.sync(30_000) {
                    Ok(cmds) => {
                        last_sync_ok.store(epoch_secs(), Ordering::SeqCst);
                        for c in cmds {
                            if tx.send(c).is_err() {
                                return; // supervisor gone
                            }
                        }
                    }
                    Err(()) => std::thread::sleep(Duration::from_secs(5)),
                }
            }
        })
        .expect("spawn matrix-sync thread");
    rx
}
