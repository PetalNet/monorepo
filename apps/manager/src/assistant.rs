//! Authenticated per-user Claude Code specialization used by Lab Console.
//!
//! Console-api remains the authorization boundary: it sends only a short-lived, caller-scoped MCP
//! credential. This service never receives a browser credential. Sessions and message receipts are
//! durable so `(external_session_id, message_id)` is exactly-once across retries and restarts.

use crate::config::Config;
use crate::state::{epoch_secs, write_file_atomic, Heartbeat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;

const MAX_BODY: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    id: String,
    external_id: String,
    #[serde(default)]
    initialized: bool,
    #[serde(skip)]
    mcp_url: String,
    #[serde(skip)]
    mcp_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Receipt {
    request_hash: String,
    message_id: String,
    content: String,
    tool_results: Vec<serde_json::Value>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Ledger {
    sessions: HashMap<String, Session>,
    receipts: HashMap<String, Receipt>,
}

struct State {
    ledger: Ledger,
    path: PathBuf,
    in_flight: HashSet<String>,
}

#[derive(Deserialize)]
struct EnsureRequest {
    schema_version: u32,
    external_session_id: String,
    profile: String,
    mcp: Mcp,
}

#[derive(Deserialize)]
struct Mcp {
    url: String,
    bearer_token: String,
}

#[derive(Deserialize)]
struct MessageRequest {
    schema_version: u32,
    message_id: String,
    kind: String,
    content: String,
}

#[derive(Deserialize)]
struct LookupRequest {
    schema_version: u32,
    message_id: String,
}

pub fn spawn(cfg: Config) -> Result<(), String> {
    let bind = cfg.assistant_api_bind.clone().ok_or("missing bind")?;
    let token = cfg.assistant_api_token.clone().ok_or("missing token")?;
    let server = Server::http(&bind).map_err(|e| format!("cannot bind {bind}: {e}"))?;
    let state = Arc::new(Mutex::new(State {
        ledger: load_ledger(&cfg.assistant_receipts_path),
        path: cfg.assistant_receipts_path.clone(),
        in_flight: HashSet::new(),
    }));
    std::thread::Builder::new()
        .name("console-assistant-api".into())
        .spawn(move || {
            eprintln!("[manager/assistant] listening on {bind}");
            for request in server.incoming_requests() {
                handle(request, &cfg, &token, &state);
            }
        })
        .map_err(|e| format!("cannot start thread: {e}"))?;
    Ok(())
}

fn load_ledger(path: &Path) -> Ledger {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn persist(state: &State) -> Result<(), String> {
    if let Some(parent) = state.path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec(&state.ledger).map_err(|e| e.to_string())?;
    write_file_atomic(&state.path, &bytes, Some(0o600)).map_err(|e| e.to_string())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut diff = left.len() ^ right.len();
    for i in 0..left.len().max(right.len()) {
        diff |= usize::from(*left.get(i).unwrap_or(&0) ^ *right.get(i).unwrap_or(&0));
    }
    diff == 0
}

fn authenticated(request: &Request, token: &str) -> bool {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv("authorization"))
        .is_some_and(|h| {
            constant_time_eq(
                h.value.as_str().as_bytes(),
                format!("Bearer {token}").as_bytes(),
            )
        })
}

fn read_json<T: for<'de> Deserialize<'de>>(request: &mut Request) -> Result<T, &'static str> {
    let mut bytes = Vec::new();
    request
        .as_reader()
        .take(MAX_BODY + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "read_failed")?;
    if bytes.len() as u64 > MAX_BODY {
        return Err("body_too_large");
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_json")
}

fn json(request: Request, status: u16, value: serde_json::Value) {
    let header = Header::from_bytes("content-type", "application/json").expect("static header");
    let _ = request.respond(
        Response::from_string(value.to_string())
            .with_status_code(StatusCode(status))
            .with_header(header),
    );
}

fn handle(mut request: Request, cfg: &Config, token: &str, state: &Arc<Mutex<State>>) {
    if request.method() == &Method::Get && request.url() == "/healthz" {
        return health(request, cfg);
    }
    if request.method() != &Method::Post {
        return json(
            request,
            405,
            serde_json::json!({"error":"method_not_allowed"}),
        );
    }
    if !authenticated(&request, token) {
        return json(request, 401, serde_json::json!({"error":"unauthorized"}));
    }
    let path = request.url().to_owned();
    if path == "/v1/sessions/ensure" {
        let body: EnsureRequest = match read_json(&mut request) {
            Ok(v) => v,
            Err(e) => return json(request, 400, serde_json::json!({"error":e})),
        };
        if body.schema_version != 1
            || body.profile != "lab-console-dashboard"
            || body.external_session_id.len() > 256
            || body.mcp.bearer_token.len() < 32
            || !body.mcp.url.starts_with("http")
        {
            return json(request, 400, serde_json::json!({"error":"invalid_session"}));
        }
        let mut guard = state.lock().expect("assistant ledger poisoned");
        let session = guard
            .ledger
            .sessions
            .entry(body.external_session_id.clone())
            .or_insert_with(|| Session {
                id: Uuid::new_v4().to_string(),
                external_id: body.external_session_id,
                initialized: false,
                mcp_url: String::new(),
                mcp_token: String::new(),
            });
        session.mcp_url = body.mcp.url;
        session.mcp_token = body.mcp.bearer_token;
        let id = session.id.clone();
        if let Err(error) = persist(&guard) {
            return json(
                request,
                503,
                serde_json::json!({"error":"receipt_unavailable","detail":error}),
            );
        }
        return json(request, 200, serde_json::json!({"session_id":id}));
    }
    let Some((session_id, action)) = parse_session_path(&path) else {
        return json(request, 404, serde_json::json!({"error":"not_found"}));
    };
    if action == "lookup" {
        let body: LookupRequest = match read_json(&mut request) {
            Ok(v) => v,
            Err(e) => return json(request, 400, serde_json::json!({"error":e})),
        };
        if body.schema_version != 1 {
            return json(request, 400, serde_json::json!({"error":"invalid_version"}));
        }
        let guard = state.lock().expect("assistant ledger poisoned");
        let key = format!("{session_id}\0{}", body.message_id);
        return match guard.ledger.receipts.get(&key) {
            Some(receipt) => json(request, 200, receipt_json(receipt)),
            None => json(request, 404, serde_json::json!({"error":"not_found"})),
        };
    }
    let body: MessageRequest = match read_json(&mut request) {
        Ok(v) => v,
        Err(e) => return json(request, 400, serde_json::json!({"error":e})),
    };
    if body.schema_version != 1
        || !matches!(body.kind.as_str(), "user" | "context")
        || body.content.is_empty()
        || body.content.len() > 100_000
    {
        return json(request, 400, serde_json::json!({"error":"invalid_message"}));
    }
    let request_hash = Sha256::digest(format!("{}\0{}", body.kind, body.content).as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let key = format!("{session_id}\0{}", body.message_id);
    let session = {
        let mut guard = state.lock().expect("assistant ledger poisoned");
        if let Some(receipt) = guard.ledger.receipts.get(&key) {
            if receipt.request_hash != request_hash {
                return json(request, 409, serde_json::json!({"error":"id_reused"}));
            }
            return json(request, 200, receipt_json(receipt));
        }
        if !guard.in_flight.insert(key.clone()) {
            return json(
                request,
                409,
                serde_json::json!({"error":"message_in_flight"}),
            );
        }
        match guard
            .ledger
            .sessions
            .values()
            .find(|s| s.id == session_id && !s.mcp_token.is_empty())
        {
            Some(session) => session.clone(),
            None => {
                guard.in_flight.remove(&key);
                return json(
                    request,
                    404,
                    serde_json::json!({"error":"session_not_found"}),
                );
            }
        }
    };
    match run_claude(cfg, &session, &body.content) {
        Ok((content, tool_results)) => {
            let receipt = Receipt {
                request_hash,
                message_id: body.message_id,
                content,
                tool_results,
            };
            let response = receipt_json(&receipt);
            let mut guard = state.lock().expect("assistant ledger poisoned");
            guard.ledger.receipts.insert(key.clone(), receipt);
            if let Some(stored) = guard
                .ledger
                .sessions
                .values_mut()
                .find(|stored| stored.id == session.id)
            {
                stored.initialized = true;
            }
            guard.in_flight.remove(&key);
            if let Err(error) = persist(&guard) {
                return json(
                    request,
                    503,
                    serde_json::json!({"error":"receipt_unavailable","detail":error}),
                );
            }
            json(request, 200, response);
        }
        Err(_error) => {
            sentry::capture_message("console assistant executor failed", sentry::Level::Error);
            state
                .lock()
                .expect("assistant ledger poisoned")
                .in_flight
                .remove(&key);
            json(
                request,
                503,
                serde_json::json!({"error":"executor_unavailable"}),
            )
        }
    }
}

fn parse_session_path(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix("/v1/sessions/")?;
    if let Some(id) = rest.strip_suffix("/messages/lookup") {
        return Some((id, "lookup"));
    }
    rest.strip_suffix("/messages").map(|id| (id, "message"))
}

fn receipt_json(receipt: &Receipt) -> serde_json::Value {
    serde_json::json!({"message_id":receipt.message_id,"content":receipt.content,"tool_results":receipt.tool_results})
}

fn run_claude(
    cfg: &Config,
    session: &Session,
    prompt: &str,
) -> Result<(String, Vec<serde_json::Value>), String> {
    let assistant_dir = cfg
        .assistant_receipts_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("assistant-sessions");
    std::fs::create_dir_all(&assistant_dir).map_err(|e| e.to_string())?;
    let mcp_path = cfg
        .assistant_receipts_path
        .with_extension(format!("mcp-{}.json", session.id));
    let mcp = serde_json::json!({"mcpServers":{"lab-console":{"type":"http","url":session.mcp_url,"headers":{"Authorization":format!("Bearer {}",session.mcp_token)}}}});
    write_file_atomic(&mcp_path, mcp.to_string().as_bytes(), Some(0o600))
        .map_err(|e| e.to_string())?;
    let mut command = Command::new(&cfg.claude_bin);
    command
        .current_dir(&assistant_dir)
        .args(["--print", "--output-format", "json"])
        .args([
            "--tools",
            "",
            "--strict-mcp-config",
            "--disable-slash-commands",
        ])
        .args(["--setting-sources", "", "--permission-mode", "dontAsk"])
        .args(["--allowedTools", "mcp__lab-console__*"])
        .arg(if session.initialized {
            "--resume"
        } else {
            "--session-id"
        })
        .arg(&session.id)
        .arg("--mcp-config")
        .arg(&mcp_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(model) = &cfg.assistant_model {
        command.args(["--model", model]);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("cannot start Claude: {e}"))?;
    use std::io::Write;
    child
        .stdin
        .take()
        .ok_or("Claude stdin unavailable")?
        .write_all(prompt.as_bytes())
        .map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(55);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&mcp_path);
            return Err("Claude execution timed out".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&mcp_path);
    if !output.status.success() {
        return Err("Claude execution failed".into());
    }
    if output.stdout.len() > MAX_BODY as usize {
        return Err("Claude response exceeded the manager limit".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "Claude returned invalid JSON")?;
    let content = value
        .get("result")
        .and_then(|v| v.as_str())
        .ok_or("Claude omitted result")?
        .to_owned();
    let tools = value
        .get("tool_results")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok((content, tools))
}

fn health(request: Request, cfg: &Config) {
    let heartbeat = std::fs::read_to_string(&cfg.heartbeat_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Heartbeat>(&text).ok());
    let fresh = heartbeat.as_ref().is_some_and(|hb| {
        epoch_secs().saturating_sub(hb.updated_at_epoch) <= 30 && hb.state == "running"
    });
    json(
        request,
        if fresh { 200 } else { 503 },
        serde_json::json!({"schema_version":1,"healthy":fresh,"executor":"manager","heartbeat_age_s":heartbeat.map(|hb| epoch_secs().saturating_sub(hb.updated_at_epoch))}),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn paths_are_exact_and_auth_compare_handles_lengths() {
        assert_eq!(
            parse_session_path("/v1/sessions/a/messages"),
            Some(("a", "message"))
        );
        assert_eq!(
            parse_session_path("/v1/sessions/a/messages/lookup"),
            Some(("a", "lookup"))
        );
        assert_eq!(parse_session_path("/v1/sessions/a/nope"), None);
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"different"));
    }

    #[test]
    fn ledger_round_trip_does_not_persist_mcp_credentials() {
        let mut ledger = Ledger::default();
        ledger.sessions.insert(
            "external".into(),
            Session {
                id: "session".into(),
                external_id: "external".into(),
                initialized: false,
                mcp_url: "https://console".into(),
                mcp_token: "secret".into(),
            },
        );
        let text = serde_json::to_string(&ledger).unwrap();
        assert!(!text.contains("secret"));
        let restored: Ledger = serde_json::from_str(&text).unwrap();
        assert_eq!(restored.sessions["external"].id, "session");
        assert!(restored.sessions["external"].mcp_token.is_empty());
    }

    #[test]
    fn http_contract_deduplicates_before_executor_dispatch() {
        let root = std::env::temp_dir().join(format!("assistant-http-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let calls = root.join("calls");
        let claude = root.join("fake-claude");
        std::fs::write(
            &claude,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nprintf '%s' '{{\"result\":\"manager reply\",\"tool_results\":[]}}'\n",
                calls.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o700)).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let token = "0123456789abcdef0123456789abcdef";
        let cfg = Config {
            creds_path: root.join("creds"),
            control_room: "!test:example.org".into(),
            agent_name: "janet".into(),
            work_dir: root.clone(),
            state_path: root.join("state"),
            rate_limit_hook_path: root.join("rate-limit"),
            model_override_path: None,
            exit_code_path: root.join("exit"),
            heartbeat_path: root.join("heartbeat"),
            sessions_dir: root.join("sessions"),
            tmux_session: "unused".into(),
            pane_tag: "unused".into(),
            claude_bin: claude.to_string_lossy().into_owned(),
            claude_args: vec![],
            path_prepend: String::new(),
            kill_agent_on_shutdown: true,
            tmux_width: 80,
            tmux_height: 24,
            assistant_api_bind: Some(format!("127.0.0.1:{port}")),
            assistant_api_token: Some(token.into()),
            assistant_receipts_path: root.join("receipts.json"),
            assistant_model: None,
            glitchtip_dsn: None,
        };
        spawn(cfg).unwrap();
        let base = format!("http://127.0.0.1:{port}");
        let ensure: serde_json::Value = ureq::post(&format!("{base}/v1/sessions/ensure"))
			.set("authorization", &format!("Bearer {token}"))
			.send_json(serde_json::json!({"schema_version":1,"external_session_id":"principal-hash","profile":"lab-console-dashboard","mcp":{"url":"http://console.test/api/v1/assistant/mcp","bearer_token":"abcdefghijklmnopqrstuvwxyz-123456"}}))
			.unwrap().into_json().unwrap();
        let session = ensure["session_id"].as_str().unwrap();
        let url = format!("{base}/v1/sessions/{session}/messages");
        let payload = serde_json::json!({"schema_version":1,"message_id":"message-1","kind":"user","content":"hello"});
        for _ in 0..2 {
            let response: serde_json::Value = ureq::post(&url)
                .set("authorization", &format!("Bearer {token}"))
                .send_json(payload.clone())
                .unwrap()
                .into_json()
                .unwrap();
            assert_eq!(response["content"], "manager reply");
        }
        let second = serde_json::json!({"schema_version":1,"message_id":"message-2","kind":"user","content":"again"});
        ureq::post(&url)
            .set("authorization", &format!("Bearer {token}"))
            .send_json(second)
            .unwrap();
        let invocations = std::fs::read_to_string(&calls).unwrap();
        assert_eq!(invocations.lines().count(), 2);
        assert!(invocations.lines().next().unwrap().contains("--session-id"));
        assert!(invocations.lines().nth(1).unwrap().contains("--resume"));
        assert!(invocations.contains("--strict-mcp-config"));
        assert!(invocations.contains("--permission-mode dontAsk"));
        assert!(invocations.contains("--allowedTools mcp__lab-console__*"));
        let conflict = ureq::post(&url).set("authorization", &format!("Bearer {token}")).send_json(serde_json::json!({"schema_version":1,"message_id":"message-1","kind":"user","content":"changed"})).unwrap_err();
        assert_eq!(conflict.into_response().unwrap().status(), 409);
        let saved = std::fs::read_to_string(root.join("receipts.json")).unwrap();
        assert!(!saved.contains("abcdefghijklmnopqrstuvwxyz-123456"));
    }
}
