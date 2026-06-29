use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead as _, Write as _};
use time::OffsetDateTime;

#[derive(Deserialize, Debug)]
struct JsonRpcRequest {
    /// JSON-RPC version tag ("2.0"). Captured for wire-format fidelity when
    /// deserializing incoming requests; we don't branch on it, so it's unread.
    #[allow(dead_code)]
    jsonrpc: String,
    method: String,
    #[serde(default)]
    params: Value,
    id: Option<Value>,
}

#[derive(Serialize, Debug)]
struct JsonRpcResponse {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
    id: Option<Value>,
}

#[derive(Serialize, Debug)]
struct JsonRpcError {
    code: i32,
    message: String,
}

/// # Panics
///
/// Panics if the current time cannot be formatted as RFC 3339 (should never happen in practice).
pub fn run_mcp_server(server_name: &str) {
    if server_name != "time" {
        eprintln!("Unknown internal server: {server_name}");
        std::process::exit(1);
    }

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    // Tools definition
    let tools = serde_json::json!({
        "tools": [
            {
                "name": "get_current_time",
                "description": "Returns the current UTC time.",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        ]
    });

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };

        if let Ok(req) = serde_json::from_str::<JsonRpcRequest>(&line) {
            let mut response = JsonRpcResponse {
                jsonrpc: "2.0".to_owned(),
                result: None,
                error: None,
                id: req.id.clone(),
            };

            match req.method.as_str() {
                "initialize" => {
                    response.result = Some(serde_json::json!({
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "tools": {}
                        },
                        "serverInfo": {
                            "name": "matrix-bot-time",
                            "version": "1.0.0"
                        }
                    }));
                }
                "tools/list" => {
                    response.result = Some(tools.clone());
                }
                "tools/call" => {
                    if let Some(params) = req.params.as_object() {
                        if let Some(name) = params.get("name").and_then(|v| v.as_str()) {
                            if name == "get_current_time" {
                                let now = OffsetDateTime::now_utc();
                                let time_str = now
                                    .format(&time::format_description::well_known::Rfc3339)
                                    .unwrap();
                                response.result = Some(serde_json::json!({
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": time_str
                                        }
                                    ]
                                }));
                            } else {
                                response.error = Some(JsonRpcError {
                                    code: -32601,
                                    message: format!("Tool not found: {name}"),
                                });
                            }
                        } else {
                            response.error = Some(JsonRpcError {
                                code: -32602,
                                message: "Missing 'name' parameter".to_owned(),
                            });
                        }
                    } else {
                        response.error = Some(JsonRpcError {
                            code: -32602,
                            message: "Invalid params".to_owned(),
                        });
                    }
                }
                "notificiations/initialized" => {
                    // ignore
                    continue;
                }
                _ => {
                    // MCP has ping etc. — ignore unknown methods
                }
            }

            if response.result.is_some() || response.error.is_some() {
                let out = serde_json::to_string(&response).unwrap();
                let _ = writeln!(stdout, "{out}");
                let _ = stdout.flush();
            }
        }
    }
}
