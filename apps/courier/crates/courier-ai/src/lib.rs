//! AI chat plugin: `!ai <prompt>` and `@name` mentions, answered by an
//! `OpenAI`-compatible or Gemini chat API, with optional MCP tool servers,
//! per-room history context, and PII redaction.
//!
//! Ported feature-for-feature from the previous generation's `plugin-ai`;
//! config keys, env vars, history file format and reply formatting are all
//! wire-compatible. Deliberate differences: the `mcp-servers` config key
//! (as spelled in the production config) is now honored alongside
//! `mcp_servers`, replies go through the bounded `send_text`, and the
//! plugin declares a 300s command budget for multi-turn tool loops.

use core::time::Duration;
use std::collections::{BTreeSet, HashMap};

use anyhow::Result;
use async_trait::async_trait;
use matrix_sdk::ruma::events::room::message::{MessageType, OriginalSyncRoomMessageEvent};
use tracing::{debug, error, info, warn};

mod gemini;
mod history;
mod mcp;
pub mod mcp_server;
mod pii;

pub use mcp_server::run_mcp_server;

use courier_core::{
    plugin::{Plugin, PluginContext, PluginSpec, PluginTriggers, RoomMessageMeta, str_config},
    send::send_text,
    text::to_bold,
};

/// Budget for one `run()` invocation: the tool loop can legitimately spend
/// several bounded 30s HTTP calls plus MCP tool executions.
const AI_COMMAND_BUDGET: Duration = Duration::from_secs(300);

const DEFAULT_SYSTEM_PROMPT: &str = r"
You're an AI in a group chat. Reply naturally when tagged.

(context grabbed from the chat)
";

/// The AI chat plugin.
#[derive(Debug)]
pub struct AiTool;

fn base_triggers() -> PluginTriggers {
    let mut triggers = PluginTriggers {
        commands: vec!["!ai".into()],
        mentions: vec!["@claire".into()],
    };
    if let Some(handle) = ai_env_handle() {
        triggers.mentions.push(handle);
    }
    triggers
}

#[async_trait]
impl Plugin for AiTool {
    fn id(&self) -> &'static str {
        "ai"
    }
    fn help(&self) -> &'static str {
        "Ask the AI: !ai <prompt>"
    }
    fn spec(&self) -> PluginSpec {
        PluginSpec {
            id: "ai".into(),
            enabled: true,
            dev_only: None,
            triggers: base_triggers(),
            config: serde_yaml::Value::default(),
        }
    }
    fn wants_own_messages(&self) -> bool {
        true
    }
    fn handles_room_messages(&self) -> bool {
        true
    }
    fn command_budget(&self) -> Option<Duration> {
        Some(AI_COMMAND_BUDGET)
    }

    async fn on_room_message(
        &self,
        ctx: &PluginContext,
        event: &OriginalSyncRoomMessageEvent,
        spec: &PluginSpec,
        meta: &RoomMessageMeta,
    ) -> Result<()> {
        trigger_backfill(ctx, spec);

        let Some(body) = message_body(&event.content.msgtype) else {
            return Ok(());
        };

        history::record(ctx, event, body).await;

        if meta.triggered_plugins.contains(self.id()) {
            return Ok(());
        }

        let Some(own_id) = ctx.client.user_id() else {
            return Ok(());
        };
        if event.sender == own_id {
            return Ok(());
        }

        if body.trim().is_empty() {
            return Ok(());
        }

        let body_lc = body.to_lowercase();
        for handle in fallback_handles(ctx, spec) {
            if body_lc.contains(&handle) {
                info!(plugin = %self.id(), handle, "Fallback mention matched; delegating to run()");
                if let Err(err) = self.run(ctx, body, spec).await {
                    warn!(error = %err, plugin = %self.id(), "AI fallback run failed");
                }
                break;
            }
        }

        Ok(())
    }

    async fn run(&self, ctx: &PluginContext, args: &str, spec: &PluginSpec) -> Result<()> {
        use serde_json::Value;

        #[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
        struct ToolCall {
            id: String,
            #[serde(rename = "type")]
            kind: String, // "function"
            function: ToolCallFunction,
        }
        #[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
        struct ToolCallFunction {
            name: String,
            arguments: String, // JSON string
        }
        #[derive(serde::Deserialize)]
        struct ChoiceMsg {
            content: Option<String>,
            tool_calls: Option<Vec<ToolCall>>,
        }
        #[derive(serde::Deserialize)]
        struct Choice {
            message: ChoiceMsg,
        }
        #[derive(serde::Deserialize)]
        struct ChatResp {
            choices: Vec<Choice>,
        }
        #[derive(serde::Serialize, Clone, Debug)]
        struct Msg {
            role: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            content: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            tool_calls: Option<Vec<Value>>, // Value to hold ToolCall generic
            #[serde(skip_serializing_if = "Option::is_none")]
            tool_call_id: Option<String>,
        }
        #[derive(serde::Serialize, Clone)]
        struct ToolDef {
            #[serde(rename = "type")]
            kind: String, // "function"
            function: ToolFnDef,
        }
        #[derive(serde::Serialize, Clone)]
        struct ToolFnDef {
            name: String,
            description: Option<String>,
            parameters: Value,
        }
        #[derive(serde::Serialize)]
        struct Body {
            model: String,
            messages: Vec<Msg>,
            max_tokens: Option<u32>,
            #[serde(skip_serializing_if = "Vec::is_empty")]
            tools: Vec<ToolDef>,
        }

        let (args_no_log, log_to_room) = extract_log_flag(args);
        let prompt_raw = args_no_log.trim();
        if prompt_raw.is_empty() {
            return send_text(ctx, "Usage: !ai <prompt>").await;
        }

        let pii_enabled = spec
            .config
            .get("pii_redaction")
            .and_then(serde_yaml::Value::as_bool)
            .unwrap_or(false);
        // Start typing indicator
        let _ = ctx.room.typing_notice(true).await;

        let ner_enabled = spec
            .config
            .get("pii_ner")
            .and_then(serde_yaml::Value::as_bool)
            .unwrap_or(false);

        let mut redactor = if ner_enabled {
            pii::PiiRedactor::with_ner()
        } else {
            pii::PiiRedactor::new()
        };

        let prompt = if pii_enabled {
            redactor.redact(prompt_raw)
        } else {
            prompt_raw.to_owned()
        };

        // Initialize MCP clients
        let mut mcp_clients = Vec::new();
        if let Some(servers) = mcp_servers_config(spec) {
            for (name, config) in servers {
                let name = name.as_str().unwrap_or("unknown");
                if let Some(cmd_str) = config.get("command").and_then(|v| v.as_str()) {
                    let mut cmd = cmd_str.to_owned();
                    let mut args_vec = Vec::new();

                    // Check for explicit args list
                    if let Some(args_seq) = config.get("args").and_then(|v| v.as_sequence()) {
                        for arg in args_seq {
                            if let Some(s) = arg.as_str() {
                                args_vec.push(s.to_owned());
                            }
                        }
                    } else {
                        // Fallback: split command string
                        let parts: Vec<String> =
                            cmd_str.split_whitespace().map(ToOwned::to_owned).collect();
                        if !parts.is_empty() {
                            cmd.clone_from(&parts[0]);
                            args_vec = parts[1..].to_vec();
                        }
                    }

                    info!("Connecting to MCP server: {name} ({cmd} {args_vec:?})");
                    match mcp::McpClient::new(&cmd, &args_vec).await {
                        Ok(client) => {
                            mcp_clients.push(client);
                        }
                        Err(e) => {
                            warn!("Failed to connect to MCP server {name}: {e}");
                            send_text(ctx, format!("MCP connection failed for {name}: {e}"))
                                .await?;
                        }
                    }
                }
            }
        }

        // Fetch tools from all clients
        let mut tools = Vec::new();
        let mut tool_map = HashMap::new(); // map tool name to client index
        for (i, client) in mcp_clients.iter().enumerate() {
            match client.list_tools().await {
                Ok(client_tools) => {
                    for t in client_tools {
                        tools.push(ToolDef {
                            kind: "function".to_owned(),
                            function: ToolFnDef {
                                name: t.name.clone(),
                                description: t.description,
                                parameters: t.input_schema,
                            },
                        });
                        tool_map.insert(t.name, i);
                    }
                }
                Err(e) => {
                    warn!("Failed to list tools from MCP client {client:?}: {e}");
                }
            }
        }

        let provider = str_config(spec, "provider").unwrap_or_else(|| "openai".to_owned());

        let api_base = str_config(spec, "api_base").or_else(|| std::env::var("AI_API_BASE").ok());

        let api_path = str_config(spec, "api_path").or_else(|| std::env::var("AI_API_PATH").ok());

        let model = str_config(spec, "model")
            .or_else(|| std::env::var("AI_MODEL").ok())
            .unwrap_or_else(|| {
                if provider == "gemini" {
                    "gemini-1.5-flash".to_owned()
                } else {
                    "gpt-4o-mini".to_owned()
                }
            });

        let (api_key_opt, key_source) = resolve_api_key(spec, &provider);
        let Some(api_key) = api_key_opt else {
            // Debug: log what we checked
            let config_key = str_config(spec, "api_key").is_some();
            let ai_api_key = std::env::var("AI_API_KEY").ok();
            let google_key = std::env::var("GOOGLE_API_KEY").ok();
            let openai_key = std::env::var("OPENAI_API_KEY").ok();
            warn!(
                "AI request blocked: no API key set. Debug: provider={}, config.api_key={}, AI_API_KEY={:?}, GOOGLE_API_KEY={:?}, OPENAI_API_KEY={:?}",
                provider,
                config_key,
                ai_api_key.as_ref().map(|_| "[SET]"),
                google_key.as_ref().map(|_| "[SET]"),
                openai_key.as_ref().map(|_| "[SET]")
            );
            return send_text(ctx, "AI key missing: set config.api_key etc").await;
        };

        let chat_path = api_path.unwrap_or_else(|| "/v1/chat/completions".to_owned());
        let url = match api_base {
            Some(base) => format!("{}{chat_path}", base.trim_end_matches('/')),
            None if provider == "gemini" => format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
            ),
            None => format!("https://api.openai.com{chat_path}"),
        };

        let name = ai_name(spec);
        let system_prompt_base = spec
            .config
            .get("system_prompt")
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_SYSTEM_PROMPT)
            .to_owned();

        let mut system_prompt = format!(
            "Your name is {name}. People will tag you as @{name}.
Routing prefixes like !dev.command or @dev.name are delivery hints; ignore them when referring to yourself or others.
{system_prompt_base}",
        );
        let ctx_lines = history::read_last_history(&ctx.history_dir, ctx.room.room_id(), 11);
        let context_lines = ctx_lines.join("\n");

        let history_status = if context_lines.is_empty() {
            let hist_path = history::history_path(ctx.history_dir.as_ref(), ctx.room.room_id());
            format!("No history found at: {}", hist_path.display())
        } else {
            format!("Loaded {} messages", ctx_lines.len())
        };

        if !context_lines.is_empty() {
            system_prompt = system_prompt
                .replace("(handle)", format!("@{name}").as_str())
                .replacen("(context grabbed from the chat)", &context_lines, 1);
        }

        if pii_enabled {
            system_prompt = redactor.redact(&system_prompt);
        }

        system_prompt.push_str("\n\nIMPORTANT: Do not use markdown formatting. Do not use bold (**text**), italics (*text*), or lists. Write in plain text paragraphs only. Keep your response very concise and short (under 100 words).");

        info!(
            provider = %provider,
            model = %model,
            url = %url,
            key_source = %key_source,
            tools_count = %tools.len(),
            pii = %pii_enabled,
            "AI request prepared"
        );

        if log_to_room {
            let debug_info = format!(
                "🔧 DEBUG INFO\n\
                Provider: {}\n\
                Model: {}\n\
                Tools: {}\n\
                PII Redaction: {}\n\
                History: {}\n\
                \n\
                📋 SYSTEM PROMPT:\n\
                {}\n\
                \n\
                💬 USER PROMPT:\n\
                {}",
                provider,
                model,
                tools.len(),
                pii_enabled,
                history_status,
                system_prompt,
                prompt
            );
            let _ = send_text(ctx, debug_info).await;
        }

        let mut messages = vec![
            Msg {
                role: "system".into(),
                content: Some(system_prompt.clone()),
                tool_calls: None,
                tool_call_id: None,
            },
            Msg {
                role: "user".into(),
                content: Some(prompt.clone()),
                tool_calls: None,
                tool_call_id: None,
            },
        ];

        let max_turns = 10;
        let mut turn = 0;

        loop {
            turn += 1;
            if turn > max_turns {
                send_text(ctx, "AI tool loop limit exceeded").await?;
                break;
            }

            if log_to_room {
                let _ = send_text(ctx, format!("AI turn {turn} calling API...")).await;
            }

            // A reqwest client with no timeout would let a stalled provider
            // request park this task until the supervisor budget kills the
            // whole run. Bound every request instead.
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .connect_timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());

            let mut final_content: Option<String> = None;
            let mut final_tool_calls: Vec<ToolCall> = Vec::new();

            if provider == "gemini" {
                // Convert messages to Gemini format
                use gemini::{Content, FunctionDeclaration, GeminiBody, Part, Tools};

                let mut gemini_contents = Vec::new();
                let mut system_inst = None;

                for msg in &messages {
                    match msg.role.as_str() {
                        "system" => {
                            if let Some(c) = &msg.content {
                                system_inst = Some(Content {
                                    // System prompt is passed via the
                                    // system_instruction field with a user role.
                                    role: "user".into(),
                                    parts: vec![Part::Text { text: c.clone() }],
                                });
                            }
                        }
                        "user" => {
                            if let Some(c) = &msg.content {
                                gemini_contents.push(Content {
                                    role: "user".into(),
                                    parts: vec![Part::Text { text: c.clone() }],
                                });
                            }
                        }
                        "assistant" => {
                            let mut parts = Vec::new();
                            if let Some(c) = &msg.content {
                                parts.push(Part::Text { text: c.clone() });
                            }
                            if let Some(tcs) = &msg.tool_calls {
                                for tc_val in tcs {
                                    if let Ok(tc) =
                                        serde_json::from_value::<ToolCall>(tc_val.clone())
                                        && let Ok(args_val) =
                                            serde_json::from_str::<Value>(&tc.function.arguments)
                                    {
                                        parts.push(Part::FunctionCall {
                                            function_call: gemini::FunctionCall {
                                                name: tc.function.name,
                                                args: args_val,
                                            },
                                        });
                                    }
                                }
                            }
                            if !parts.is_empty() {
                                gemini_contents.push(Content {
                                    role: "model".into(),
                                    parts,
                                });
                            }
                        }
                        "tool" => {
                            // Tool response
                            let response_content = msg.content.clone().unwrap_or_default();

                            // Reconstruct logic for finding function name
                            let mut fn_name = "unknown".to_owned();
                            'scan: for m in messages.iter().rev() {
                                if m.role == "assistant"
                                    && let Some(tcs) = &m.tool_calls
                                {
                                    for tc_val in tcs {
                                        if let Ok(tc) =
                                            serde_json::from_value::<ToolCall>(tc_val.clone())
                                            && Some(&tc.id) == msg.tool_call_id.as_ref()
                                        {
                                            fn_name.clone_from(&tc.function.name);
                                            break 'scan;
                                        }
                                    }
                                }
                            }

                            gemini_contents.push(Content {
                                role: "function".into(),
                                parts: vec![Part::FunctionResponse {
                                    function_response: gemini::FunctionResponse {
                                        name: fn_name,
                                        response: serde_json::json!({ "content": response_content }),
                                    },
                                }],
                            });
                        }
                        _ => {}
                    }
                }

                let gemini_tools = if tools.is_empty() {
                    None
                } else {
                    Some(vec![Tools {
                        function_declarations: tools
                            .iter()
                            .map(|t| FunctionDeclaration {
                                name: t.function.name.clone(),
                                description: t.function.description.clone(),
                                parameters: {
                                    let sanitized =
                                        gemini::sanitize_schema(t.function.parameters.clone());
                                    debug!("Sanitized schema for {}: {sanitized}", t.function.name);
                                    sanitized
                                },
                            })
                            .collect(),
                    }])
                };

                let body = GeminiBody {
                    contents: gemini_contents,
                    tools: gemini_tools,
                    system_instruction: system_inst,
                };

                let resp = client.post(&url).json(&body).send().await;

                match resp {
                    Ok(r) => {
                        let status = r.status();
                        if !status.is_success() {
                            let text = r.text().await.unwrap_or_default();
                            warn!("Gemini API error: {status} {text}");
                            send_text(ctx, format!("Gemini error: {text}")).await?;
                            return Ok(());
                        }
                        let text = r.text().await.unwrap_or_default();
                        error!("Gemini Raw Response: {text}");
                        match serde_json::from_str::<gemini::GeminiResponse>(&text) {
                            Ok(g_resp) => {
                                if let Some(candidates) = g_resp.candidates
                                    && let Some(cand) = candidates.first()
                                {
                                    let mut text_parts = Vec::new();
                                    for part in &cand.content.parts {
                                        match part {
                                            Part::Text { text } => {
                                                text_parts.push(text.clone());
                                            }
                                            Part::FunctionCall { function_call } => {
                                                final_tool_calls.push(ToolCall {
                                                    id: format!("call_{}", uuid::Uuid::new_v4()),
                                                    kind: "function".into(),
                                                    function: ToolCallFunction {
                                                        name: function_call.name.clone(),
                                                        arguments: serde_json::to_string(
                                                            &function_call.args,
                                                        )
                                                        .unwrap_or_default(),
                                                    },
                                                });
                                            }
                                            Part::FunctionResponse { .. } => {}
                                        }
                                    }
                                    if !text_parts.is_empty() {
                                        final_content = Some(text_parts.join("\n"));
                                    }
                                }
                            }
                            Err(e) => {
                                warn!("Failed to parse Gemini JSON: {e}");
                                send_text(ctx, format!("Gemini JSON error: {e}")).await?;
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        warn!("HTTP error: {e}");
                        send_text(ctx, format!("HTTP error: {e}")).await?;
                        break;
                    }
                }
            } else {
                // OpenAI
                let body = Body {
                    model: model.clone(),
                    messages: messages.clone(),
                    max_tokens: Some(1024),
                    tools: tools.clone(),
                };

                let resp = client
                    .post(&url)
                    .bearer_auth(&api_key)
                    .json(&body)
                    .send()
                    .await;

                match resp {
                    Ok(r) => {
                        let status = r.status();
                        if !status.is_success() {
                            let text = r.text().await.unwrap_or_default();
                            warn!("AI API error: {status} {text}");
                            send_text(ctx, format!("AI error: {text}")).await?;
                            return Ok(());
                        }
                        match r.json::<ChatResp>().await {
                            Ok(p) => {
                                if let Some(choice) = p.choices.first() {
                                    final_content.clone_from(&choice.message.content);
                                    if let Some(tcs) = &choice.message.tool_calls {
                                        final_tool_calls.clone_from(tcs);
                                    }
                                }
                            }
                            Err(e) => {
                                warn!("Failed to parse JSON: {e}");
                                send_text(ctx, format!("JSON parse error: {e}")).await?;
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        warn!("HTTP error: {e}");
                        send_text(ctx, format!("HTTP error: {e}")).await?;
                        break;
                    }
                }
            }

            // Handle results (common)
            let tool_calls_json = if final_tool_calls.is_empty() {
                None
            } else {
                serde_json::to_value(&final_tool_calls)
                    .ok()
                    .and_then(|v| v.as_array().cloned())
            };

            if final_content.is_some() || tool_calls_json.is_some() {
                messages.push(Msg {
                    role: "assistant".into(),
                    content: final_content.clone(),
                    tool_calls: tool_calls_json,
                    tool_call_id: None,
                });
            }

            if let Some(text) = &final_content
                && !text.trim().is_empty()
            {
                // Output to room - RESTORE PII
                let restored_text = if pii_enabled {
                    redactor.restore(text)
                } else {
                    text.clone()
                };

                let prefix = format!("@{name}:");
                let bold_prefix = to_bold(&prefix);
                // send_text adds the DEV MODE banner and auto-threads the
                // reply under the triggering @mention.
                send_text(ctx, format!("{bold_prefix} {restored_text}")).await?;
            }

            if final_tool_calls.is_empty() {
                // Done
                break;
            }
            if log_to_room {
                send_text(
                    ctx,
                    format!("Executing {} tool calls...", final_tool_calls.len()),
                )
                .await?;
            }

            for call in final_tool_calls {
                let mut result_content =
                    if let Some(&client_idx) = tool_map.get(&call.function.name) {
                        // RESTORE PII in Args
                        let args_str = if pii_enabled {
                            redactor.restore(&call.function.arguments)
                        } else {
                            call.function.arguments.clone()
                        };

                        if let Ok(args) = serde_json::from_str::<Value>(&args_str) {
                            info!("Calling tool {} with {args:?}", call.function.name);
                            match mcp_clients[client_idx]
                                .call_tool(&call.function.name, args)
                                .await
                            {
                                Ok(res) => res.to_string(),
                                Err(e) => format!("Error: {e}"),
                            }
                        } else {
                            "Invalid JSON arguments".to_owned()
                        }
                    } else {
                        format!("Unknown tool: {}", call.function.name)
                    };

                // REDACT PII in Result
                if pii_enabled {
                    result_content = redactor.redact(&result_content);
                }

                messages.push(Msg {
                    role: "tool".into(),
                    content: Some(result_content),
                    tool_calls: None,
                    tool_call_id: Some(call.id.clone()),
                });
            }
        }

        // Stop typing indicator
        let _ = ctx.room.typing_notice(false).await;
        Ok(())
    }
}

/// The MCP servers mapping from the spec config. The production config
/// spells the key `mcp-servers`; the documented spelling is `mcp_servers`.
/// Accept both (underscore wins when both are present).
fn mcp_servers_config(spec: &PluginSpec) -> Option<&serde_yaml::Mapping> {
    spec.config
        .get("mcp_servers")
        .or_else(|| spec.config.get("mcp-servers"))
        .and_then(serde_yaml::Value::as_mapping)
}

/// Resolve the API key and a human-readable description of where it came
/// from. Resolution order (first hit wins): `config.api_key`, the env var
/// named by `config.api_key_env` (terminal: no further fallback, matching
/// the previous generation), `AI_API_KEY`, then the provider-specific
/// `GOOGLE_API_KEY` / `OPENAI_API_KEY`.
fn resolve_api_key(spec: &PluginSpec, provider: &str) -> (Option<String>, String) {
    if let Some(k) = str_config(spec, "api_key") {
        return (Some(k), "config.api_key".to_owned());
    }
    if let Some(env_name) = str_config(spec, "api_key_env") {
        let val = std::env::var(&env_name).ok();
        let source = if val.is_some() {
            format!("env.{env_name}")
        } else {
            String::new()
        };
        return (val, source);
    }
    if let Ok(k) = std::env::var("AI_API_KEY") {
        return (Some(k), "env.AI_API_KEY".to_owned());
    }
    let provider_env = if provider == "gemini" {
        "GOOGLE_API_KEY"
    } else {
        "OPENAI_API_KEY"
    };
    std::env::var(provider_env).map_or_else(
        |_| (None, String::new()),
        |k| (Some(k), format!("env.{provider_env}")),
    )
}

fn ai_env_handle() -> Option<String> {
    std::env::var("AI_HANDLE").ok().map(|raw| {
        if raw.starts_with('@') {
            raw
        } else {
            format!("@{raw}")
        }
    })
}

fn ai_name(spec: &PluginSpec) -> String {
    spec.config
        .get("name")
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned)
        .or_else(|| std::env::var("AI_NAME").ok())
        .unwrap_or_else(|| "Claire".to_owned())
}

const fn message_body(msgtype: &MessageType) -> Option<&str> {
    match msgtype {
        MessageType::Text(inner) => Some(inner.body.as_str()),
        MessageType::Notice(inner) => Some(inner.body.as_str()),
        MessageType::Emote(inner) => Some(inner.body.as_str()),
        MessageType::Audio(_)
        | MessageType::File(_)
        | MessageType::Image(_)
        | MessageType::Location(_)
        | MessageType::ServerNotice(_)
        | MessageType::Video(_)
        | MessageType::VerificationRequest(_)
        | _ => None,
    }
}

fn fallback_handles(ctx: &PluginContext, spec: &PluginSpec) -> BTreeSet<String> {
    let mut handles: BTreeSet<String> = BTreeSet::new();
    if let Some(handle) = ai_env_handle() {
        handles.insert(handle.to_lowercase());
    }

    let name = ai_name(spec).to_lowercase();
    if ctx.dev_active {
        debug!(name = %name, dev_id = ?ctx.dev_id, "AI fallback in dev mode");
        if let Some(dev_id) = ctx.dev_id.as_deref() {
            handles.insert(format!("@{}.{name}", dev_id.to_lowercase()));
        }
    } else {
        handles.insert(format!("@{name}"));
    }

    debug!(handles = ?handles, "AI fallback handles");

    handles
}

fn trigger_backfill(ctx: &PluginContext, spec: &PluginSpec) {
    let enable = spec
        .config
        .get("history_backfill_on_start")
        .and_then(serde_yaml::Value::as_bool)
        .unwrap_or(false);
    if !enable {
        return;
    }
    let limit = spec
        .config
        .get("history_backfill_lines")
        .and_then(serde_yaml::Value::as_u64)
        .unwrap_or(50);
    history::spawn_backfill_once(ctx.client.clone(), ctx.history_dir.as_ref().clone(), limit);
}

fn extract_log_flag(args: &str) -> (String, bool) {
    let mut out: Vec<&str> = Vec::new();
    let mut flag = false;
    for t in args.split_whitespace() {
        if t == "-log" || t == "--log" {
            flag = true;
        } else {
            out.push(t);
        }
    }
    (out.join(" "), flag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_servers_key_accepts_underscore_and_dash() {
        let underscore: PluginSpec =
            serde_yaml::from_str("id: ai\nmcp_servers:\n  time:\n    command: echo\n")
                .expect("spec parses");
        assert!(mcp_servers_config(&underscore).is_some());

        let dashed: PluginSpec = serde_yaml::from_str(
            "id: ai\nmcp-servers:\n  websearch:\n    command: npx\n    args: [\"-y\", \"@guhcostan/web-search-mcp\"]\n",
        )
        .expect("spec parses");
        let servers = mcp_servers_config(&dashed).expect("dashed key honored");
        assert_eq!(servers.len(), 1);

        let none: PluginSpec = serde_yaml::from_str("id: ai\n").expect("spec parses");
        assert!(mcp_servers_config(&none).is_none());
    }

    #[test]
    fn extract_log_flag_strips_both_spellings() {
        assert_eq!(extract_log_flag("hi there"), ("hi there".to_owned(), false));
        assert_eq!(
            extract_log_flag("hi -log there"),
            ("hi there".to_owned(), true)
        );
        assert_eq!(extract_log_flag("--log hi"), ("hi".to_owned(), true));
    }
}
