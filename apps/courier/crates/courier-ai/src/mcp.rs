//! Minimal MCP (Model Context Protocol) stdio client.
//!
//! Spawns an MCP server as a subprocess and speaks line-delimited JSON-RPC
//! over its stdin/stdout. Every request is bounded: if the subprocess never
//! answers (hung `npx` child, lost stdio), the request times out instead of
//! parking the calling task forever.

use core::sync::atomic::{AtomicU64, Ordering};
use core::time::Duration;
use std::{collections::HashMap, process::Stdio, sync::Arc};

use anyhow::{Context as _, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
    process::{Child, Command},
    sync::{Mutex, mpsc, oneshot},
};
use tracing::{debug, error, info, warn};

/// Deadline for one MCP request round-trip.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

type PendingMap = HashMap<u64, oneshot::Sender<Result<Value>>>;

#[derive(Debug)]
pub struct McpClient {
    /// The spawned server's command line, used as an identifier in
    /// diagnostics (e.g. the request-timeout error below).
    name: String,
    /// RAII guard: owns the spawned MCP subprocess `Child` so it lives as
    /// long as the client. Intentionally never read — dropping this field
    /// would kill the subprocess, so it must be held even though it looks
    /// unused.
    #[allow(dead_code)]
    process: Mutex<Option<Child>>,
    tx: mpsc::Sender<JsonRpcMessage>,
    requests: Arc<Mutex<PendingMap>>,
    next_id: AtomicU64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(untagged)]
enum JsonRpcMessage {
    Request(JsonRpcRequest),
    Response(JsonRpcResponse),
    Notification(JsonRpcNotification),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct JsonRpcRequest {
    jsonrpc: String,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
    id: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct JsonRpcResponse {
    jsonrpc: String,
    result: Option<Value>,
    error: Option<JsonRpcError>,
    id: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct JsonRpcNotification {
    jsonrpc: String,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct JsonRpcError {
    code: i64,
    message: String,
    data: Option<Value>,
}

impl McpClient {
    /// Spawn `cmd args...` as an MCP server and complete the initialize
    /// handshake.
    ///
    /// # Errors
    ///
    /// Returns an error when the subprocess cannot be spawned, its stdio
    /// pipes cannot be opened, or the initialize round-trip fails/times out.
    pub async fn new(cmd: &str, args: &[String]) -> Result<Arc<Self>> {
        let mut child = Command::new(cmd)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Failed to spawn MCP server process")?;

        let stdin = child.stdin.take().context("Failed to open stdin")?;
        let stdout = child.stdout.take().context("Failed to open stdout")?;
        let stderr = child.stderr.take().context("Failed to open stderr")?;

        let (tx, mut rx) = mpsc::channel::<JsonRpcMessage>(32);
        let requests: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(HashMap::new()));
        let requests_clone = Arc::clone(&requests);

        // Writer task
        tokio::spawn(async move {
            let mut writer = stdin;
            while let Some(msg) = rx.recv().await {
                let json = serde_json::to_string(&msg).unwrap_or_default();
                debug!("Sending to MCP stdin: {json}");
                if let Err(e) = writer.write_all(json.as_bytes()).await {
                    error!("Failed to write to MCP stdin: {e}");
                    break;
                }
                if let Err(e) = writer.write_all(b"\n").await {
                    error!("Failed to write newline to MCP stdin: {e}");
                    break;
                }
                if let Err(e) = writer.flush().await {
                    error!("Failed to flush MCP stdin: {e}");
                    break;
                }
            }
        });

        // Stderr reader task
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                info!("MCP STDERR: {line}");
            }
        });

        // Reader task
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                debug!("Received MCP line: {line}");
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<JsonRpcMessage>(&line) {
                    Ok(JsonRpcMessage::Response(res)) => {
                        let JsonRpcResponse {
                            result, error, id, ..
                        } = res;
                        let sender = requests_clone.lock().await.remove(&id);
                        if let Some(sender) = sender {
                            let outcome = error.map_or_else(
                                || Ok(result.unwrap_or(Value::Null)),
                                |err| Err(anyhow!("RPC error {}: {}", err.code, err.message)),
                            );
                            let _ = sender.send(outcome);
                        }
                    }
                    Ok(JsonRpcMessage::Request(req)) => {
                        warn!("Ignored server request: {}", req.method);
                    }
                    Ok(JsonRpcMessage::Notification(notif)) => {
                        debug!("MCP Notification: {}", notif.method);
                    }
                    Err(e) => {
                        error!("Failed to parse MCP message: {e} | Line: {line}");
                    }
                }
            }
            info!("MCP Reader task ended");
        });

        let client = Arc::new(Self {
            name: format!("{cmd} {}", args.join(" ")),
            process: Mutex::new(Some(child)),
            tx,
            requests,
            next_id: AtomicU64::new(1),
        });

        client.initialize().await?;

        Ok(client)
    }

    async fn request(&self, method: &str, params: Option<Value>) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();

        self.requests.lock().await.insert(id, tx);

        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: method.into(),
            params,
            id,
        };

        self.tx
            .send(JsonRpcMessage::Request(req))
            .await
            .context("Failed to send request to writer task")?;

        // Bound the wait: if the MCP subprocess never answers (hung npx
        // child, lost stdio), this future would otherwise hang forever. Time
        // it out and clean up the pending slot.
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(result) => result.context("Failed to receive response")?,
            Err(_elapsed) => {
                self.requests.lock().await.remove(&id);
                let server = &self.name;
                anyhow::bail!(
                    "MCP request '{method}' to server '{server}' timed out after {}s",
                    REQUEST_TIMEOUT.as_secs()
                );
            }
        }
    }

    async fn initialize(&self) -> Result<()> {
        let params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "roots": {
                    "listChanged": false
                },
                "sampling": {}
            },
            "clientInfo": {
                "name": "relay-bot-ai-plugin",
                "version": "0.1.0"
            }
        });

        let res = self.request("initialize", Some(params)).await?;
        debug!("MCP Initialize response: {res:?}");

        // After initialize, we must send notification "notifications/initialized"
        let notif = JsonRpcNotification {
            jsonrpc: "2.0".into(),
            method: "notifications/initialized".into(),
            params: None,
        };
        self.tx.send(JsonRpcMessage::Notification(notif)).await?;

        Ok(())
    }

    /// Ask the server for its tool catalog.
    ///
    /// # Errors
    ///
    /// Returns an error when the request fails/times out or the response has
    /// no parsable `tools` array.
    pub async fn list_tools(&self) -> Result<Vec<McpTool>> {
        let res = self.request("tools/list", None).await?;
        let tools_val = res
            .get("tools")
            .ok_or_else(|| anyhow!("No 'tools' in response"))?;
        let tools: Vec<McpTool> = serde_json::from_value(tools_val.clone())?;
        Ok(tools)
    }

    /// Invoke tool `name` with `args`.
    ///
    /// # Errors
    ///
    /// Returns an error when the request fails, times out, or the server
    /// reports a JSON-RPC error.
    pub async fn call_tool(&self, name: &str, args: Value) -> Result<Value> {
        let params = serde_json::json!({
            "name": name,
            "arguments": args
        });
        self.request("tools/call", Some(params)).await
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}
