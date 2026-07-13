//! agent-manager — Rust port of Janet's manager.js (task-561).
//!
//! Supervises a persistent Claude Code agent session living in a tmux pane:
//! spawn (first boot: --session-id) / resume (--resume), rate-limit wait +
//! auto-resume, crash backoff, Matrix !commands, stable pane ownership, and
//! a heartbeat + healthcheck for canary-gated deploys.
//!
//! Usage:
//!   agent-manager run [work-dir]      supervise (default subcommand)
//!   agent-manager healthcheck [opts]  gate for canary/rollback (exit 0/1)
//!   agent-manager version
//!
//! Config comes from the JSON file at $AGENT_MANAGER_CONFIG; nothing
//! host-specific is compiled in. See config.example.json / the runbook.

mod assistant;
mod config;
mod health;
mod matrix;
mod state;
mod supervisor;
mod tmux;

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

use config::Config;
use state::SessionState;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let sub = args.first().map(String::as_str).unwrap_or("run");
    match sub {
        "run" => run_manager(args.get(1).map(String::as_str)),
        "healthcheck" => healthcheck(&args[1..]),
        "version" | "--version" | "-V" => {
            println!("agent-manager {}", env!("CARGO_PKG_VERSION"));
        }
        "help" | "--help" | "-h" => usage(0),
        other => {
            eprintln!("unknown subcommand {other:?}");
            usage(2);
        }
    }
}

fn usage(code: i32) -> ! {
    eprintln!(
        "usage: agent-manager run [work-dir]\n       agent-manager healthcheck [--json] [--max-heartbeat-age SECS] [--max-sync-age SECS] [--allow-state STATE]...\n       agent-manager version\n\nconfig: JSON file at ${}",
        config::CONFIG_ENV
    );
    std::process::exit(code);
}

fn die(msg: &str) -> ! {
    eprintln!("[manager] FATAL: {msg}");
    std::process::exit(2);
}

fn run_manager(work_dir_arg: Option<&str>) {
    let cfg = Config::load(work_dir_arg).unwrap_or_else(|e| die(&e));
    let _glitchtip_guard = cfg.glitchtip_dsn.as_deref().map(|dsn| {
        sentry::init((
            dsn,
            sentry::ClientOptions {
                release: sentry::release_name!(),
                ..Default::default()
            },
        ))
    });
    let creds = cfg.load_creds().unwrap_or_else(|e| die(&e));
    let session = SessionState::load_or_create(&cfg.state_path);

    println!(
        "[manager] agent-manager {} starting",
        env!("CARGO_PKG_VERSION")
    );
    println!("[manager] agent: {}", cfg.agent_name);
    println!(
        "[manager] session: {} (bootstrapped={})",
        session.session_id, session.bootstrapped
    );
    println!("[manager] work dir: {}", cfg.work_dir.display());
    println!("[manager] control room: {}", cfg.control_room);
    println!(
        "[manager] tmux session: {} (pane tag: {})",
        cfg.tmux_session, cfg.pane_tag
    );
    println!("[manager] commands: start | stop | restart | status | kill session | /compact /context /cost /status");

    if cfg.assistant_api_bind.is_some() {
        assistant::spawn(cfg.clone()).unwrap_or_else(|e| die(&format!("assistant API: {e}")));
    }

    // Graceful-shutdown flags: either signal flips `shutdown`; `sigterm`
    // records which one for the goodbye message.
    let shutdown = Arc::new(AtomicBool::new(false));
    let sigterm = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&sigterm))
        .unwrap_or_else(|e| die(&format!("cannot register SIGTERM handler: {e}")));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&shutdown))
        .unwrap_or_else(|e| die(&format!("cannot register SIGTERM handler: {e}")));
    signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&shutdown))
        .unwrap_or_else(|e| die(&format!("cannot register SIGINT handler: {e}")));

    let last_sync_ok = Arc::new(AtomicU64::new(0));

    // Two independent Matrix clients: one for the outbound queue, one for
    // the sync loop (each thread owns its own connection state).
    let send_client = matrix::MatrixClient::new(&creds, &cfg.control_room);
    let sync_client = matrix::MatrixClient::new(&creds, &cfg.control_room);

    // Self-heal seam: on an auth failure BOTH the sync loop and the sender
    // re-read the creds file (which the control-plane token authority rewrites
    // on rotation) and swap in the fresh token without a manager restart — so
    // the control channel recovers in both directions.
    let sync_creds_path = cfg.creds_path.clone();
    let send_creds_path = cfg.creds_path.clone();
    let (matrix_tx, sender_handle) = matrix::spawn_sender(
        send_client,
        Some(move || crate::config::MatrixCreds::from_path(&send_creds_path)),
    );
    let cmd_rx = matrix::spawn_command_loop(
        sync_client,
        Arc::clone(&shutdown),
        Arc::clone(&last_sync_ok),
        Some(move || crate::config::MatrixCreds::from_path(&sync_creds_path)),
    );

    // Boot announcement (JS parity).
    let sid8: String = session.session_id.chars().take(8).collect();
    let _ = matrix_tx.send(format!(
        "{} manager online — session {sid8}...\n!start !stop !restart !status !kill session",
        cfg.agent_name
    ));

    let sup = supervisor::Supervisor::new(
        cfg,
        session,
        Arc::clone(&shutdown),
        Arc::clone(&sigterm),
        matrix_tx,
        cmd_rx,
        last_sync_ok,
    );
    sup.run(); // blocks until shutdown; drops the last Sender on return

    // Flush the outbound queue (bounded: every send has a 15s timeout and
    // the queue is tiny; systemd's stop timeout is the outer bound).
    let _ = sender_handle.join();
    println!("[manager] bye");
}

fn healthcheck(args: &[String]) {
    let mut opts = health::HealthOpts::default();
    let mut allow_overridden = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--json" => opts.json = true,
            "--max-heartbeat-age" => match it.next().and_then(|v| v.parse().ok()) {
                Some(v) => opts.max_heartbeat_age = v,
                None => die("--max-heartbeat-age needs an integer argument"),
            },
            "--max-sync-age" => match it.next().and_then(|v| v.parse().ok()) {
                Some(v) => opts.max_sync_age = v,
                None => die("--max-sync-age needs an integer argument"),
            },
            "--allow-state" => match it.next() {
                Some(v) => {
                    if !allow_overridden {
                        opts.allow_states.clear();
                        allow_overridden = true;
                    }
                    opts.allow_states.push(v.clone());
                }
                None => die("--allow-state needs an argument"),
            },
            other => die(&format!("unknown healthcheck flag {other:?}")),
        }
    }
    let cfg = Config::load(None).unwrap_or_else(|e| die(&e));
    std::process::exit(health::run(&cfg, &opts));
}
