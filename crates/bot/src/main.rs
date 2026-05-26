mod logging;
mod plugins;

use core::time::Duration;
use std::{
    collections::HashSet,
    fs,
    io::IsTerminal as _,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context as _, Result, anyhow};
use clap::Parser;
use futures_util::StreamExt as _;
use matrix_sdk::{
    Client, HttpError, SessionMeta,
    authentication::{SessionTokens, matrix::MatrixSession},
    config::SyncSettings,
    encryption::verification::{
        SasState, SasVerification, Verification, VerificationRequest, VerificationRequestState,
    },
    room::Room,
    ruma::events::{
        key::verification::{
            request::ToDeviceKeyVerificationRequestEvent, start::ToDeviceKeyVerificationStartEvent,
        },
        room::{
            member::{MembershipState, StrippedRoomMemberEvent},
            message::{MessageType, OriginalSyncRoomMessageEvent},
        },
    },
};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::logging::init_tracing;
use plugin_core::{PluginContext, PluginSpec, RoomMessageMeta, truncate};

#[derive(Parser, Debug)]
#[command(
    name = "matrix-ping-bot",
    version,
    about = "Simple Matrix ping bot with E2EE"
)]
struct Args {
    /// Homeserver base URL, e.g. `https://matrix-client.matrix.org`.
    #[arg(long, env = "MATRIX_HOMESERVER")]
    homeserver: String,

    /// Username (localpart or full user ID)
    #[arg(long, env = "MATRIX_USERNAME")]
    username: String,

    /// Password (if omitted, will prompt if needed)
    #[arg(long, env = "MATRIX_PASSWORD")]
    password: Option<String>,

    /// Directory for persistent state (encryption keys, sync cache)
    #[arg(long, env = "MATRIX_STORE", default_value = "./bot-store")]
    store: PathBuf,

    /// JSON session file for access token/device info
    #[arg(long, env = "MATRIX_SESSION_FILE", default_value = "./session.json")]
    session_file: PathBuf,

    /// Device display name
    #[arg(long, env = "MATRIX_DEVICE_NAME", default_value = "matrix-ping-bot")]
    device_name: String,

    /// Path to YAML config describing room clusters to relay between
    #[arg(long, env = "MATRIX_CONFIG", default_value = "./config.yaml")]
    config: PathBuf,

    /// Disable auto-joining rooms when invited
    #[arg(long)]
    no_autojoin: bool,

    /// Auto-accept and confirm SAS verifications (insecure for production)
    #[arg(long, env = "MATRIX_AUTO_VERIFY", default_value_t = true)]
    auto_verify: bool,

    /// Sync timeout in milliseconds
    #[arg(long, env = "MATRIX_SYNC_TIMEOUT_MS", default_value_t = 30000)]
    sync_timeout_ms: u64,

    /// Enable dev-mode behaviors (must also be enabled in config)
    #[arg(short = 'd', long = "dev")]
    dev: bool,

    /// Instance mode override via env/flag: "dev" or "prod"
    #[arg(long, env = "MATRIX_MODE")]
    mode: Option<String>,

    /// Run as an internal MCP server (e.g. "time") instead of the bot
    #[arg(long)]
    mcp_server: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SavedSession {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    user_id: String,
    device_id: String,
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct BotConfig {
    pub(crate) clusters: Vec<RoomCluster>,
    #[serde(default)]
    pub(crate) reupload_media: Option<bool>,
    #[serde(default)]
    pub(crate) caption_media: Option<bool>,
    #[serde(default)]
    pub(crate) dev_mode: Option<bool>,
    #[serde(default)]
    pub(crate) dev_id: Option<String>,
    #[serde(default, alias = "tools")]
    pub(crate) plugins: Option<Vec<PluginSpec>>,
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct RoomCluster {
    pub(crate) rooms: Vec<String>,
    #[serde(default)]
    pub(crate) reupload_media: Option<bool>,
    #[serde(default)]
    pub(crate) caption_media: Option<bool>,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    // Load .env if present so clap can pick up env vars.
    let _ = dotenvy::dotenv();
    let args = Args::parse();

    if let Some(tool_name) = args.mcp_server {
        plugin_ai::run_mcp_server(&tool_name);
        return Ok(());
    }

    fs::create_dir_all(&args.store)
        .with_context(|| format!("creating store directory at {}", args.store.display()))?;

    // Build client with SQLite store to persist E2EE state.
    let mut client = build_client(&args).await?;

    // Restore session if available; otherwise login.
    let (restored_from_session, restored_device_id) =
        if let Some(session) = load_session(&args.session_file)? {
            info!("Restoring session for {}", session.user_id);
            let session_device_id = session.device_id.clone();
            let matrix_session = MatrixSession {
                meta: SessionMeta {
                    user_id: session.user_id.parse().context("invalid stored user_id")?,
                    device_id: session.device_id.into(),
                },
                tokens: SessionTokens {
                    access_token: session.access_token,
                    refresh_token: session.refresh_token,
                },
            };
            client
                .restore_session(matrix_session)
                .await
                .context("restoring session")?;
            (true, Some(session_device_id))
        } else {
            let password = resolve_password(
                args.password.as_deref(),
                &args.session_file,
                "No MATRIX_PASSWORD provided and no stored session",
            )?;
            login_with_store_recovery(&mut client, &args, &password, None).await?;
            (false, None)
        };

    // Validate restored session before installing handlers/syncing.
    if restored_from_session {
        match client.whoami().await {
            Ok(_) => {}
            Err(error) if is_unknown_token_http_error(&error) => {
                warn!(
                    error = %error,
                    "Stored session token is invalid; attempting fresh login"
                );
                let password = resolve_password(
                    args.password.as_deref(),
                    &args.session_file,
                    "Stored session is invalid and re-login is required",
                )?;
                client = build_client(&args).await?;
                login_with_store_recovery(
                    &mut client,
                    &args,
                    &password,
                    restored_device_id.as_deref(),
                )
                .await
                .context("re-login failed after invalid stored session")?;
            }
            Err(error) => return Err(anyhow!("session validation failed: {error}")),
        }
    }

    let config = load_config(&args.config)?;
    let env_dev = matches!(args.mode.as_deref(), Some(m) if m.eq_ignore_ascii_case("dev"));
    let dev_active = (args.dev || env_dev) && config.dev_mode.unwrap_or(false);
    let dev_id = config.dev_id.as_ref().map(|s| Arc::<str>::from(s.as_str()));
    if dev_active && dev_id.is_none() {
        return Err(anyhow!(
            "Dev mode requested but no dev_id provided in config.yaml"
        ));
    }
    // Loud banner so mode is obvious at startup
    print_mode_banner(dev_active, dev_id.as_deref());
    // Build plugin registry
    let registry = plugins::build_registry(&config).await;
    let history_dir = Arc::new(args.store.join("history"));
    // Log registered plugin commands/mentions for visibility
    let entries_for_log = registry.entries().await;
    let mut mention_set = std::collections::BTreeSet::new();
    let mut command_set = std::collections::BTreeSet::new();
    for (_, entry) in &entries_for_log {
        for cmd in &entry.spec.triggers.commands {
            let normalized = if cmd.starts_with('!') {
                cmd.clone()
            } else {
                format!("!{cmd}")
            };
            command_set.insert(normalized);
        }
        for mention in &entry.spec.triggers.mentions {
            let raw = if mention.starts_with('@') {
                mention.clone()
            } else {
                format!("@{mention}")
            };
            mention_set.insert(raw.to_lowercase());
        }
    }
    let mention_keys: Vec<String> = mention_set.into_iter().collect();
    let command_keys: Vec<String> = command_set.into_iter().collect();
    info!(mentions = ?mention_keys, commands = ?command_keys, "Registered plugin triggers");

    // Auto-join handler for invites
    if !args.no_autojoin {
        client.add_event_handler(
            async move |ev: StrippedRoomMemberEvent, room: Room, client: Client| {
                if ev.content.membership != MembershipState::Invite {
                    return;
                }
                let Some(own_id) = client.user_id() else {
                    return;
                };
                if ev.state_key != own_id.as_str() {
                    return;
                }
                info!(room_id = %room.room_id(), "Auto-joining invited room");
                if let Err(e) = room.join().await {
                    warn!(error = %e, "Failed to accept invite");
                }
            },
        );
    }

    // Message handler: plugins + relay
    client.add_event_handler(async move |ev: OriginalSyncRoomMessageEvent, room: Room, client: Client| {
        // Identify own user; do not early-return yet so we can record history even for own messages
        let Some(own_id) = client.user_id() else { return; };
        // Log incoming message details for diagnostics
        let msg_kind = match &ev.content.msgtype {
            MessageType::Text(_) => "text",
            MessageType::Notice(_) => "notice",
            MessageType::Emote(_) => "emote",
            MessageType::Image(_) => "image",
            MessageType::File(_) => "file",
            MessageType::Audio(_) => "audio",
            MessageType::Video(_) => "video",
            MessageType::Location(_) | MessageType::ServerNotice(_) | MessageType::VerificationRequest(_) | _ => "other",
        };
        let body_snippet: Option<String> = match &ev.content.msgtype {
            MessageType::Text(t) => Some(truncate(&t.body, 200)),
            MessageType::Notice(n) => Some(truncate(&n.body, 200)),
            MessageType::Emote(e) => Some(truncate(&e.body, 200)),
            MessageType::Audio(_) | MessageType::File(_) | MessageType::Image(_) | MessageType::Location(_) | MessageType::ServerNotice(_) | MessageType::Video(_) | MessageType::VerificationRequest(_) | _ => None,
        };
        info!(room_id = %room.room_id(), sender = %ev.sender, kind = %msg_kind, body = ?body_snippet, "Incoming message");

        // Plain text/notice messages; plugins by !command or @mention
        let body_opt = match &ev.content.msgtype {
            MessageType::Text(t) => Some(t.body.as_str()),
            MessageType::Notice(n) => Some(n.body.as_str()),
            MessageType::Audio(_) | MessageType::Emote(_) | MessageType::File(_) | MessageType::Image(_) | MessageType::Location(_) | MessageType::ServerNotice(_) | MessageType::Video(_) | MessageType::VerificationRequest(_) | _ => None,
        };
        let is_self = ev.sender == own_id;
        let mut triggered_plugins: HashSet<String> = HashSet::new();

        if !is_self && let Some(body) = body_opt.map(str::trim) {
            let dev_id_opt = dev_id.as_deref();
            // !command
            if body.starts_with('!') {
                let mut parts = body.splitn(2, ' ');
                let cmd = parts.next().unwrap_or("");
                let args_raw = parts.next().unwrap_or("").trim();
                let (normalized_cmd, routing) = classify_command_token(cmd, dev_id_opt);
                info!(cmd = %cmd, normalized_cmd = %normalized_cmd, route = ?routing, args = %args_raw, dev_active = dev_active, "Parsed command token");
                if let Some(entry) = registry
                    .entry_by_command(&normalized_cmd)
                    .await
                {
                    let plugin_id = entry.spec.id.clone();
                    let args_clean = args_raw.to_owned();
                    match routing {
                        DevRouting::OtherDev => {
                            info!(plugin = %plugin_id, "Ignoring command targeted at different dev id");
                        }
                        DevRouting::Dev if !dev_active => {
                            info!(plugin = %plugin_id, "Ignoring dev command in prod mode");
                        }
                        DevRouting::Prod if dev_active => {
                            info!(plugin = %plugin_id, "Ignoring prod command in dev mode");
                        }
                        _ if entry
                            .spec
                            .dev_only
                            .unwrap_or_else(|| entry.plugin.dev_only())
                            && !dev_active =>
                        {
                            info!(plugin = %plugin_id, "Ignoring dev-only plugin in prod mode");
                        }
                        _ if !registry.is_enabled(&plugin_id).await => {
                            info!(plugin = %plugin_id, "Plugin disabled");
                        }
                        DevRouting::Prod | DevRouting::Dev => {
                            let ctx = PluginContext {
                                client: client.clone(),
                                room: room.clone(),
                                dev_active,
                                dev_id: dev_id.clone(),
                                registry: Arc::clone(&registry),
                                history_dir: Arc::clone(&history_dir),
                            };
                            let plugin = Arc::clone(&entry.plugin);
                            let spec = entry.spec.clone();
                            let pid = plugin_id.clone();
                            tokio::spawn(async move {
                                match tokio::time::timeout(
                                    core::time::Duration::from_secs(60),
                                    plugin.run(&ctx, &args_clean, &spec),
                                ).await {
                                    Ok(Ok(())) => {}
                                    Ok(Err(e)) => warn!(error = %e, plugin = %pid, "Plugin failed"),
                                    Err(_) => warn!(plugin = %pid, "Plugin command handler timed out after 60s"),
                                }
                            });
                            triggered_plugins.insert(plugin_id.clone());
                        }
                    }
                }
            }
            // @mention anywhere in the message (case-insensitive; tolerant of punctuation)
            {
                let mut executed_mention = false;
                for (token_idx, token_raw) in body.split_whitespace().enumerate() {
                    debug!(token_idx, token_raw = token_raw);
                    // Fast skip: tokens without '@' cannot be mentions
                    if !token_raw.contains('@') {
                        debug!(token_idx, token_raw = token_raw, "Skip: no @ in token");
                        continue;
                    }

                    // Trim leading and trailing punctuation that commonly wraps mentions
                    let token_leading = token_raw
                        .trim_start_matches(['(', '[', '{', '<', '"', '\'']);
                    let mut token = token_leading
                        .trim_end_matches([':', ',', '.', ';', '!', '?', '…', '—', '–', ')', ']', '}', '>', '"', '\'']);
                    // Strip possessive suffixes like @ai's or @ai’s
                    if let Some(t) = token.strip_suffix("'s").or_else(|| token.strip_suffix("’s")) {
                        token = t;
                    }

                    // Only consider tokens that now begin with '@'
                    if !token.starts_with('@') {
                        debug!(token_idx, token = token, token_raw = token_raw, "Skip: token not starting with @ after trim");
                        continue;
                    }

                    let (normalized_mention, routing) = classify_mention_token(token, dev_id_opt);
                    let key = normalized_mention.to_lowercase();
                    debug!(token = token, dev_id_opt = dev_id_opt, key = key);
                    info!(token_idx, token_raw = %token_raw, token = %token, normalized = %normalized_mention, key = %key, route = ?routing, "Checking mention token");
                    let var_name =  registry
                        .entry_by_mention(&key)
                        .await;
                    debug!(pass = var_name.is_some(), "Mention lookup (reg: {:#?})", registry);

                    if let Some(entry) = var_name
                    {
                        let plugin_id = entry.spec.id.clone();
                        info!(token_idx, plugin = %plugin_id, "Mention matched");
                        // Use the FULL body as the prompt so earlier words are preserved
                        // (the AI can see the initiator and routing prefix as part of the message)
                        let args_source = body;

                        // Evaluate gating; continue scanning if not allowed
                        let blocked = match routing {
                            DevRouting::OtherDev => {
                                info!(token_idx, plugin = %plugin_id, reason = "other-dev", "Ignoring mention");
                                true
                            }
                            DevRouting::Dev if !dev_active => {
                                info!(token_idx, plugin = %plugin_id, reason = "dev-in-prod", "Ignoring mention");
                                true
                            }
                            DevRouting::Prod if dev_active => {
                                info!(token_idx, plugin = %plugin_id, reason = "prod-in-dev", "Ignoring mention");
                                true
                            }
                            _ if entry
                                .spec
                                .dev_only
                                .unwrap_or_else(|| entry.plugin.dev_only())
                                && !dev_active =>
                            {
                                info!(token_idx, plugin = %plugin_id, reason = "dev-only-in-prod", "Ignoring mention");
                                true
                            }
                            _ if !registry.is_enabled(&plugin_id).await => {
                                info!(token_idx, plugin = %plugin_id, reason = "disabled", "Ignoring mention");
                                true
                            }
                            DevRouting::Prod | DevRouting::Dev => false,
                        };

                        if blocked {
                            continue; // keep scanning for a later valid mention
                        }

                        let ctx = PluginContext {
                            client: client.clone(),
                            room: room.clone(),
                            dev_active,
                            dev_id: dev_id.clone(),
                            registry: Arc::clone(&registry),
                            history_dir: Arc::clone(&history_dir),
                        };
                        let plugin = Arc::clone(&entry.plugin);
                        let spec = entry.spec.clone();
                        let pid = plugin_id.clone();
                        let args_owned = args_source.to_owned();
                        tokio::spawn(async move {
                            match tokio::time::timeout(
                                core::time::Duration::from_secs(60),
                                plugin.run(&ctx, &args_owned, &spec),
                            ).await {
                                Ok(Ok(())) => {}
                                Ok(Err(e)) => warn!(error = %e, plugin = %pid, "Plugin failed"),
                                Err(_) => warn!(plugin = %pid, "Plugin mention handler timed out after 60s"),
                            }
                        });
                        triggered_plugins.insert(plugin_id.clone());
                        executed_mention = true;
                        // Handle only the first mention that actually targets this instance
                        break;
                    }
                }
                if !executed_mention {
                    debug!("No actionable mention found in message");
                }
            }
        }

        let meta = RoomMessageMeta {
            body: body_opt.map(ToOwned::to_owned),
            triggered_plugins: Arc::new(triggered_plugins),
        };

        // Passive plugins (e.g., relay)
        let passive_entries = registry.entries().await;
        if !passive_entries.is_empty() {
            let base_ctx = PluginContext {
                client: client.clone(),
                room: room.clone(),
                dev_active,
                dev_id: dev_id.clone(),
                registry: Arc::clone(&registry),
                history_dir: Arc::clone(&history_dir),
            };

            for (plugin_id, entry) in passive_entries {
                if !entry.plugin.handles_room_messages() {
                    continue;
                }
                if is_self && !entry.plugin.wants_own_messages() {
                    continue;
                }
                if entry
                    .spec
                    .dev_only
                    .unwrap_or_else(|| entry.plugin.dev_only())
                    && !dev_active
                {
                    continue;
                }
                if !registry.is_enabled(&plugin_id).await {
                    continue;
                }
                let plugin = Arc::clone(&entry.plugin);
                let spec = entry.spec.clone();
                let pid = plugin_id.clone();
                let ctx_p = base_ctx.clone();
                let ev_p = ev.clone();
                let meta_p = meta.clone();
                tokio::spawn(async move {
                    match tokio::time::timeout(
                        core::time::Duration::from_secs(60),
                        plugin.on_room_message(&ctx_p, &ev_p, &spec, &meta_p),
                    ).await {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => warn!(error = %e, plugin = %pid, "Plugin on_room_message failed"),
                        Err(_) => warn!(plugin = %pid, "Passive plugin handler timed out after 60s"),
                    }
                });
            }
        }
    });

    // Emoji SAS verification handlers (print emojis to console). If auto_verify is true,
    // we will auto-confirm once emojis are shown.
    let auto_confirm = args.auto_verify;
    client.add_event_handler(async move |ev: ToDeviceKeyVerificationRequestEvent, client: Client| {
            info!(user = %ev.sender, flow = %ev.content.transaction_id, "Received verification request");
            let sender = ev.sender.clone();
            let flow_id = ev.content.transaction_id.to_string();
            tokio::spawn(async move {
                if let Some(req) = get_verification_request_with_retry(&client, &sender, &flow_id).await {
                    handle_verification_request(req, auto_confirm).await;
                } else {
                    warn!(user = %sender, flow = %flow_id, "No verification request found after retry");
                }
            });
    });

    client.add_event_handler(async move |ev: OriginalSyncRoomMessageEvent, client: Client| {
        if let MessageType::VerificationRequest(_) = &ev.content.msgtype {
            info!(user = %ev.sender, event = %ev.event_id, "Received in-room verification request");
            let sender = ev.sender.clone();
            let flow_id = ev.event_id.to_string();
            tokio::spawn(async move {
                if let Some(req) = get_verification_request_with_retry(&client, &sender, &flow_id).await {
                    handle_verification_request(req, auto_confirm).await;
                } else {
                    warn!(user = %sender, flow = %flow_id, "In-room verification request not found after retry");
                }
            });
        }
    });

    client.add_event_handler(async move |ev: ToDeviceKeyVerificationStartEvent, client: Client| {
        info!(user = %ev.sender, flow = %ev.content.transaction_id, "Received verification start");
        if let Some(Verification::SasV1(sas)) = client
            .encryption()
            .get_verification(&ev.sender, ev.content.transaction_id.as_str())
            .await
        {
            tokio::spawn(handle_sas(sas, auto_confirm));
        }

    });
    // End emoji SAS handlers

    // Start syncing with configured timeout
    info!(
        timeout_ms = args.sync_timeout_ms,
        "Starting sync… Press Ctrl+C to stop."
    );
    let settings = SyncSettings::new().timeout(Duration::from_millis(args.sync_timeout_ms));
    client
        .sync(settings)
        .await
        .map_err(|e| anyhow!("sync terminated: {e}"))
}

fn load_config(path: &PathBuf) -> Result<BotConfig> {
    if !path.exists() {
        return Err(anyhow!(
            "config file not found at {}. Create one or set --config",
            path.display()
        ));
    }
    let yaml = fs::read_to_string(path)
        .with_context(|| format!("reading config file at {}", path.display()))?;
    let cfg: BotConfig = serde_yaml::from_str(&yaml).context("parsing YAML config")?;
    Ok(cfg)
}

fn print_mode_banner(dev_active: bool, dev_id: Option<&str>) {
    let is_tty = std::io::stderr().is_terminal()
        || std::env::var("FORCE_COLOR").is_ok_and(|v| !v.is_empty());
    let (title, sub, color) = if dev_active {
        let hint = dev_id.map_or_else(
            || "Send !dev.command targets this instance".to_owned(),
            |id| format!("Send !{id}.command targets this instance"),
        );
        (
            "DEVELOPMENT MODE ACTIVE",
            hint,
            "\x1b[1;33m", // bold yellow
        )
    } else {
        let hint = dev_id.map_or_else(
            || "Relaying is enabled — commands without a dev prefix".to_owned(),
            |id| format!("Relaying enabled — commands without !{id}. prefix"),
        );
        (
            "PRODUCTION MODE",
            hint,
            "\x1b[1;32m", // bold green
        )
    };
    if is_tty {
        eprintln!(
            "{color}==============================\n  {title}\n  {sub}\n==============================\x1b[0m"
        );
    } else {
        eprintln!(
            "==============================\n  {title}\n  {sub}\n=============================="
        );
    }
    if dev_active {
        info!("Dev mode active: relay disabled");
    } else {
        info!("Prod mode: relay enabled");
    }
}

async fn handle_verification_request(request: VerificationRequest, auto_confirm: bool) {
    info!(user = %request.other_user_id(), "Accepting verification request");
    if let Err(e) = request.accept().await {
        warn!(error = %e, "Failed to accept verification request");
        return;
    }
    let mut stream = request.changes();
    while let Some(state) = stream.next().await {
        match state {
            VerificationRequestState::Transitioned { verification } => {
                if let Some(sas) = verification.sas() {
                    tokio::spawn(handle_sas(sas, auto_confirm));
                }
                break;
            }
            VerificationRequestState::Cancelled(info) => {
                warn!(reason = %info.reason(), "Verification cancelled (request stage)");
                break;
            }
            VerificationRequestState::Done => {
                info!("Verification already done at request stage");
                break;
            }
            VerificationRequestState::Created { .. }
            | VerificationRequestState::Requested { .. }
            | VerificationRequestState::Ready { .. } => {}
        }
    }
}

async fn get_verification_request_with_retry(
    client: &Client,
    user_id: &matrix_sdk::ruma::OwnedUserId,
    flow_id: &str,
) -> Option<VerificationRequest> {
    // The request can race event delivery; retry briefly before giving up.
    const ATTEMPTS: usize = 25;
    const SLEEP_MS: u64 = 200;
    for _ in 0..ATTEMPTS {
        if let Some(req) = client
            .encryption()
            .get_verification_request(user_id, flow_id)
            .await
        {
            return Some(req);
        }
        tokio::time::sleep(Duration::from_millis(SLEEP_MS)).await;
    }
    None
}

async fn handle_sas(sas: SasVerification, auto_confirm: bool) {
    info!(user = %sas.other_device().user_id(), device = %sas.other_device().device_id(), "Starting SAS verification");
    if let Err(e) = sas.accept().await {
        warn!(error = %e, "Failed to accept SAS");
        return;
    }

    let mut stream = sas.changes();
    while let Some(state) = stream.next().await {
        match state.clone() {
            SasState::KeysExchanged {
                emojis: Some(e), ..
            } => {
                let emoji_string = e
                    .emojis
                    .iter()
                    .map(|em| em.symbol)
                    .collect::<Vec<_>>()
                    .join(" ");
                let descriptions = e
                    .emojis
                    .iter()
                    .map(|em| em.description)
                    .collect::<Vec<_>>()
                    .join(" ");
                debug!("SAS emojis: {emoji_string}\nSAS names:  {descriptions}");
                if auto_confirm && let Err(e) = sas.confirm().await {
                    warn!(error = %e, "Failed to confirm SAS");
                }
            }
            SasState::Done { .. } => {
                info!("Verification completed");
                break;
            }
            SasState::Cancelled(info) => {
                warn!(reason = %info.reason(), "Verification cancelled (SAS stage)");
                break;
            }
            SasState::Created { .. }
            | SasState::Started { .. }
            | SasState::Accepted { .. }
            | SasState::KeysExchanged { .. }
            | SasState::Confirmed => {}
        }
    }
}

fn load_session(path: &PathBuf) -> Result<Option<SavedSession>> {
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(path)
        .with_context(|| format!("reading session file at {}", path.display()))?;
    let session: SavedSession = serde_json::from_str(&data).context("parsing session JSON")?;
    Ok(Some(session))
}

fn save_session(path: &PathBuf, session: &SavedSession) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(session)?;
    fs::write(path, data).with_context(|| format!("writing session file at {}", path.display()))?;
    Ok(())
}

fn resolve_password(
    password_opt: Option<&str>,
    session_file: &Path,
    missing_password_reason: &str,
) -> Result<String> {
    if let Some(password) = password_opt.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(password.to_owned());
    }
    if !std::io::stdin().is_terminal() {
        return Err(anyhow!(
            "{missing_password_reason}. In Docker/non-interactive mode, set MATRIX_PASSWORD env (session file: {})",
            session_file.display()
        ));
    }
    warn!("No password provided via --password or MATRIX_PASSWORD. Prompting...");
    #[cfg(feature = "rpassword")]
    {
        rpassword::prompt_password("Matrix password:")
            .map_err(|e| anyhow!("Failed to read password: {e}"))
    }
    #[cfg(not(feature = "rpassword"))]
    {
        let _ = session_file;
        return Err(anyhow!(
            "rpassword feature is not enabled. Cannot prompt for password."
        ));
    }
}

async fn login_with_store_recovery(
    client: &mut Client,
    args: &Args,
    password: &str,
    preferred_device_id: Option<&str>,
) -> Result<()> {
    match login_and_store_session(client, args, password, preferred_device_id).await {
        Ok(()) => Ok(()),
        Err(error) if is_crypto_store_account_mismatch(&error) => {
            warn!(
                store = %args.store.display(),
                "Crypto store account/device mismatch; clearing local store and retrying login"
            );
            clear_store_dir(&args.store)?;
            *client = build_client(args).await?;
            login_and_store_session(client, args, password, preferred_device_id)
                .await
                .context("login failed after resetting crypto store")
        }
        Err(error) => Err(error),
    }
}

async fn login_and_store_session(
    client: &Client,
    args: &Args,
    password: &str,
    preferred_device_id: Option<&str>,
) -> Result<()> {
    info!("Logging in as {}", args.username);
    let mut login_builder = client
        .matrix_auth()
        .login_username(&args.username, password)
        .initial_device_display_name(&args.device_name)
        .request_refresh_token();
    if let Some(device_id) = preferred_device_id {
        login_builder = login_builder.device_id(device_id);
    }
    let response = login_builder.send().await.context("login failed")?;

    let session = SavedSession {
        access_token: response.access_token.clone(),
        refresh_token: response.refresh_token.clone(),
        user_id: response.user_id.to_string(),
        device_id: response.device_id.to_string(),
    };
    save_session(&args.session_file, &session)?;
    info!(
        "Logged in: user={} device={}",
        session.user_id, session.device_id
    );
    Ok(())
}

async fn build_client(args: &Args) -> Result<Client> {
    Client::builder()
        .homeserver_url(&args.homeserver)
        .handle_refresh_tokens()
        .sqlite_store(&args.store, None)
        .build()
        .await
        .context("building matrix client")
}

fn is_unknown_token_http_error(error: &HttpError) -> bool {
    use matrix_sdk::ruma::api::client::error::ErrorKind;

    matches!(
        error.client_api_error_kind(),
        Some(ErrorKind::UnknownToken { .. })
    )
}

fn is_crypto_store_account_mismatch(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .to_string()
            .contains("account in the store doesn't match the account in the constructor")
    })
}

fn clear_store_dir(store: &PathBuf) -> Result<()> {
    if store.exists() {
        fs::remove_dir_all(store)
            .with_context(|| format!("clearing store directory at {}", store.display()))?;
    }
    fs::create_dir_all(store)
        .with_context(|| format!("recreating store directory at {}", store.display()))?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DevRouting {
    Prod,
    Dev,
    OtherDev,
}

fn classify_command_token(cmd: &str, dev_id: Option<&str>) -> (String, DevRouting) {
    if let Some(stripped) = cmd.strip_prefix('!')
        && let Some((dev_tag, remainder)) = stripped.split_once('.')
    {
        if remainder.is_empty() {
            return (cmd.to_owned(), DevRouting::OtherDev);
        }
        let normalized = format!("!{remainder}");
        let routing = match dev_id {
            Some(expected) if expected.eq_ignore_ascii_case(dev_tag) => DevRouting::Dev,
            _ => DevRouting::OtherDev,
        };
        return (normalized, routing);
    }
    (cmd.to_owned(), DevRouting::Prod)
}

fn classify_mention_token(token: &str, dev_id: Option<&str>) -> (String, DevRouting) {
    debug!(token = token, dev_id = ?dev_id);
    if let Some(stripped) = token.strip_prefix('@')
        && let Some((dev_tag, remainder)) = stripped.split_once('.')
    {
        if remainder.is_empty() {
            return (token.to_owned(), DevRouting::OtherDev);
        }
        let normalized = format!("@{remainder}");
        let routing = match dev_id {
            Some(expected) if expected.eq_ignore_ascii_case(dev_tag) => DevRouting::Dev,
            _ => DevRouting::OtherDev,
        };
        return (normalized, routing);
    }
    (token.to_owned(), DevRouting::Prod)
}
