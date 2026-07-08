//! courier — a reliability-first Matrix relay bot.
//!
//! Startup sequence (each step guarded):
//!
//! 1. arm the startup guard (OS thread) so a wedged login can't sit dark
//!    forever;
//! 2. establish the session (restore/login, token validation, store
//!    recovery, optional secret recovery);
//! 3. build the plugin registry from config and run plugin startup hooks
//!    (including the relay's ledger-driven backfill);
//! 4. install handlers (auto-join, dispatcher, SAS verification);
//! 5. arm the sync watchdog, disarm the startup guard, and enter the
//!    supervised sync loop.

mod args;
mod dispatch;
mod engine;
mod logging;
mod plugins;
mod service;
mod session;
mod verify;

use core::time::Duration;
use std::{fs, io::IsTerminal as _, sync::Arc};

use anyhow::{Context as _, Result, anyhow};
use clap::Parser as _;
use matrix_sdk::{
    Client,
    room::Room,
    ruma::events::room::member::{MembershipState, StrippedRoomMemberEvent},
};
use tracing::{info, warn};

use courier_core::{
    config::{BotConfig, load_config},
    health::RelayHealth,
    watchdog::{self, Heartbeat, StartupGuard},
};

use crate::args::Args;

/// Everything before the sync loop must finish within this deadline or the
/// startup guard exits the process for a clean restart.
const STARTUP_DEADLINE: Duration = Duration::from_secs(30 * 60);

#[tokio::main]
async fn main() -> Result<()> {
    logging::init_tracing();

    // Load .env if present so clap can pick up env vars.
    let _ = dotenvy::dotenv();
    let args = Args::parse();

    if let Some(tool_name) = args.mcp_server {
        courier_ai::run_mcp_server(&tool_name);
        return Ok(());
    }

    if args.check_config {
        let config = load_config(&args.config)?;
        print_config_summary(&config);
        return Ok(());
    }

    fs::create_dir_all(&args.store)
        .with_context(|| format!("creating store directory at {}", args.store.display()))?;

    // Startup guard: everything from here to the sync loop (login/whoami,
    // secret recovery, plugin startup + relay backfill) runs BEFORE the sync
    // watchdog arms. If any of it wedges on a half-dead connection the bot
    // would otherwise sit dark forever with no safety net.
    let startup_guard = StartupGuard::arm(STARTUP_DEADLINE);

    let client = session::establish(&args).await?;

    let config = load_config(&args.config)?;
    let env_dev = matches!(args.mode.as_deref(), Some(m) if m.eq_ignore_ascii_case("dev"));
    let dev_active = (args.dev || env_dev) && config.dev_mode.unwrap_or(false);
    let dev_id = config.dev_id.as_ref().map(|s| Arc::<str>::from(s.as_str()));
    if dev_active && dev_id.is_none() {
        return Err(anyhow!(
            "Dev mode requested but no dev_id provided in config.yaml"
        ));
    }
    print_mode_banner(dev_active, dev_id.as_deref());

    // Per-leg relay delivery health, shared by the relay plugin, the
    // periodic reporter, and `!diag`.
    let health = Arc::new(RelayHealth::new());
    let registry = plugins::build_registry(&config, &health);
    let history_dir = Arc::new(args.store.join("history"));

    log_registered_triggers(&registry);

    // Plugin startup hooks (relay backfill lives here).
    for (plugin_id, entry) in registry.entries() {
        if entry
            .spec
            .dev_only
            .unwrap_or_else(|| entry.plugin.dev_only())
            && !dev_active
        {
            continue;
        }
        if !registry.is_enabled(&plugin_id) {
            continue;
        }
        if let Err(e) = entry
            .plugin
            .on_startup(&client, &entry.spec, Arc::clone(&history_dir), dev_active)
            .await
        {
            warn!(error = %e, plugin = %plugin_id, "Plugin startup hook failed");
        }
    }

    // Auto-join handler for invites.
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

    // Liveness heartbeat: beaten by the sync loop on every iteration AND by
    // the dispatcher on every message (a large post-outage batch must count
    // as progress).
    let heartbeat = Heartbeat::new();

    let dispatcher = Arc::new(dispatch::Dispatcher {
        registry: Arc::clone(&registry),
        dev_active,
        dev_id,
        history_dir: Arc::clone(&history_dir),
    });
    dispatch::install(&client, dispatcher, heartbeat.clone());
    verify::install(&client, args.auto_verify);

    // Reliability plumbing: periodic relay-leg health reports, the
    // out-of-band liveness watchdog, then the supervised sync loop.
    tokio::spawn(engine::health_reporter(
        Arc::clone(&health),
        Duration::from_secs(args.health_report_secs.max(60)),
    ));

    let sync_timeout = Duration::from_millis(args.sync_timeout_ms);
    if args.sync_iteration_timeout_secs != 180 {
        warn!(
            requested_secs = args.sync_iteration_timeout_secs,
            "MATRIX_SYNC_ITERATION_TIMEOUT_SECS is deprecated and ignored: cancelling a sync \
             iteration mid-processing skips events (the SDK persists the sync token before \
             handlers run); the OS-thread watchdog covers stalls instead"
        );
    }

    let mut watchdog_threshold = Duration::from_secs(args.watchdog_secs);
    if !watchdog_threshold.is_zero() {
        let min_watchdog = sync_timeout + Duration::from_secs(120);
        if watchdog_threshold < min_watchdog {
            warn!(
                requested_secs = watchdog_threshold.as_secs(),
                adjusted_secs = min_watchdog.as_secs(),
                "watchdog threshold too close to the long-poll timeout; adjusting"
            );
            watchdog_threshold = min_watchdog;
        }
    }
    watchdog::spawn(heartbeat.clone(), watchdog_threshold);

    // Startup finished; the sync watchdog owns liveness from here.
    startup_guard.disarm();

    engine::run(&client, engine::EngineConfig { sync_timeout }, heartbeat).await
}

fn log_registered_triggers(registry: &courier_core::plugin::PluginRegistry) {
    let mut mention_set = std::collections::BTreeSet::new();
    let mut command_set = std::collections::BTreeSet::new();
    for (_, entry) in registry.entries() {
        for cmd in &entry.spec.triggers.commands {
            command_set.insert(courier_core::plugin::normalize_cmd(cmd));
        }
        for mention in &entry.spec.triggers.mentions {
            mention_set.insert(courier_core::plugin::normalize_mention(mention));
        }
    }
    let mention_keys: Vec<String> = mention_set.into_iter().collect();
    let command_keys: Vec<String> = command_set.into_iter().collect();
    info!(mentions = ?mention_keys, commands = ?command_keys, "Registered plugin triggers");
}

fn print_config_summary(config: &BotConfig) {
    println!("config OK");
    println!("clusters: {}", config.clusters.len());
    for (i, cluster) in config.clusters.iter().enumerate() {
        println!("  cluster[{i}]: {} rooms", cluster.rooms.len());
        for room in &cluster.rooms {
            println!("    - {room}");
        }
        println!(
            "    reupload_media={:?} caption_media={:?} backfill_limit={:?}",
            cluster.reupload_media, cluster.caption_media, cluster.backfill_limit
        );
    }
    println!(
        "global: reupload_media={:?} caption_media={:?} backfill_limit={:?} dev_mode={:?} dev_id={:?}",
        config.reupload_media,
        config.caption_media,
        config.backfill_limit,
        config.dev_mode,
        config.dev_id
    );
    let plugin_ids: Vec<&str> = config
        .plugins
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|p| p.id.as_str())
        .collect();
    println!("plugins: {plugin_ids:?}");
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
