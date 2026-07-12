//! Dispatcher daemon: ingest spool → dispatch → deliver/queue; reap tick;
//! digest tick. Runtime v1 I/O is spool-file based (DP9) so disposable test
//! agents can exercise the whole path without any live service; the doorman
//! transport plugs into the same `CardTransport` seam in N1.4 integration.

use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dispatcher::board::Board;
use dispatcher::config::Config;
use dispatcher::deliver::{CardTransport, SpoolTransport};
use dispatcher::digest;
use dispatcher::dispatch::{Dispatcher, InboundMessage};
use dispatcher::envelope::{Envelope, EnvelopeType, METHOD_INBOX_DIGEST, RPC_SCHEMA_VERSION};
use dispatcher::glitchtip;
use dispatcher::roster::Roster;
use dispatcher::tracker::{SqliteTracker, Tracker};
use dispatcher::wake::TokenBucket;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn main() {
    let config_path =
        std::env::var("DISPATCHER_CONFIG").unwrap_or_else(|_| "dispatcher-config.json".to_string());
    let cfg = match Config::load(Path::new(&config_path)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("dispatcher: config error: {e}");
            std::process::exit(2);
        }
    };
    if let Some(dsn) = &cfg.glitchtip_dsn {
        if let Err(e) = glitchtip::init(dsn) {
            eprintln!("dispatcher: glitchtip disabled: {e}");
        }
    }
    if let Err(e) = run(cfg) {
        glitchtip::capture_message(&format!("dispatcher exiting on error: {e}"), "error");
        eprintln!("dispatcher: {e}");
        std::process::exit(1);
    }
}

fn run(cfg: Config) -> Result<(), String> {
    let board = Board::open(&cfg.db_path).map_err(|e| e.to_string())?;

    let mut roster = Roster::new(cfg.principals.clone(), cfg.system_senders.clone());
    let tracker: Option<SqliteTracker> = match &cfg.tracker_db_path {
        Some(p) => {
            let t = SqliteTracker::open(p)?;
            Some(t)
        }
        None => None,
    };
    if let Some(path) = &cfg.roster_path {
        let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let entries: Vec<dispatcher::roster::AgentEntry> =
            serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        for e in entries {
            roster.upsert_agent(e);
        }
    }
    // The tracker's agents table is the registry when no roster file is given
    // (codex P1: without this, every digest recipient looked inactive).
    if let Some(t) = &tracker {
        match t.load_roster_into(&mut roster) {
            Ok(n) => eprintln!("dispatcher: loaded {n} agents from the tracker registry"),
            Err(e) => eprintln!("dispatcher: tracker registry unavailable ({e})"),
        }
    }

    let outbox = cfg
        .outbox_dir
        .clone()
        .ok_or("outbox_dir is required for the spool runtime")?;
    let transport = SpoolTransport::new(outbox);

    let ingest_dir = cfg
        .ingest_dir
        .clone()
        .ok_or("ingest_dir is required for the spool runtime")?;
    std::fs::create_dir_all(&ingest_dir).map_err(|e| e.to_string())?;

    let mut dispatcher = Dispatcher {
        board: &board,
        roster: &roster,
        tracker: tracker.as_ref().map(|t| t as &dyn Tracker),
        transport: &transport,
        wake_bucket: TokenBucket::new(cfg.wake_rate_per_sec, cfg.wake_burst, now_ms()),
        lease_ms: cfg.lease_ms,
    };

    eprintln!(
        "dispatcher: up (board {}, ingest {}, reap {}s, digest {}s)",
        cfg.db_path.display(),
        ingest_dir.display(),
        cfg.reap_interval_secs,
        cfg.digest_interval_secs
    );

    // Crash recovery: a *.working file means a previous run died mid-pass.
    // Rename it back to *.jsonl so this pass reprocesses it. Semantics are
    // at-least-once across a crash (already-dispatched lines re-dispatch);
    // consumers de-duplicate per the card/envelope contracts (codex P1).
    let entries = std::fs::read_dir(&ingest_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("working") {
            let back = path.with_extension("jsonl");
            eprintln!(
                "dispatcher: recovering interrupted ingest file {} (at-least-once)",
                path.display()
            );
            let _ = std::fs::rename(&path, &back);
        }
    }

    let mut last_reap = Instant::now();
    let mut last_digest = Instant::now();
    loop {
        let processed = ingest_pass(&ingest_dir, &mut dispatcher)?;

        match dispatcher.redeliver_pending(now_ms(), &now_rfc3339()) {
            Ok(0) => {}
            Ok(n) => eprintln!("dispatcher: redelivered {n} pending interrupt(s)"),
            Err(e) => eprintln!("dispatcher: redelivery pass failed: {e}"),
        }

        if last_reap.elapsed() >= Duration::from_secs(cfg.reap_interval_secs) {
            last_reap = Instant::now();
            let (requeued, dead) = board.reap(now_ms()).map_err(|e| e.to_string())?;
            if !dead.is_empty() {
                glitchtip::capture_message(&format!("dead-lettered cards: {dead:?}"), "warning");
                eprintln!("dispatcher: dead-lettered {dead:?}");
            }
            if !requeued.is_empty() {
                eprintln!(
                    "dispatcher: reaped {} lease(s) back to posted",
                    requeued.len()
                );
            }
        }

        if last_digest.elapsed() >= Duration::from_secs(cfg.digest_interval_secs) {
            last_digest = Instant::now();
            digest_pass(&board, &roster, &transport, cfg.digest_max_items)?;
        }

        if processed == 0 {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

/// Consume every *.jsonl file in the ingest dir: rename to *.working first
/// (atomic take, so a crash never half-processes a file twice), then
/// dispatch line by line. Unparsable lines are logged and skipped.
fn ingest_pass(dir: &Path, dispatcher: &mut Dispatcher<'_>) -> Result<usize, String> {
    let mut processed = 0;
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let working = path.with_extension("working");
        if std::fs::rename(&path, &working).is_err() {
            continue; // raced with another consumer / vanished — fine
        }
        let content = std::fs::read_to_string(&working).map_err(|e| e.to_string())?;
        let mut failed_lines: Vec<&str> = Vec::new();
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<InboundMessage>(line) {
                Ok(msg) => match dispatcher.dispatch(&msg, now_ms(), &now_rfc3339()) {
                    Ok(routed) => {
                        processed += 1;
                        eprintln!("dispatcher: routed {routed:?}");
                    }
                    Err(e) => {
                        glitchtip::capture_message(&format!("dispatch failed: {e}"), "error");
                        eprintln!("dispatcher: dispatch failed: {e}");
                        failed_lines.push(line);
                    }
                },
                Err(e) => {
                    eprintln!("dispatcher: skipping unparsable ingest line: {e}");
                    failed_lines.push(line);
                }
            }
        }
        // Refused/unparsable lines are preserved for triage — rename the
        // .failed file back to .jsonl to retry after fixing the cause
        // (codex P1: a rejected message must never silently vanish).
        if !failed_lines.is_empty() {
            let failed = path.with_extension("failed");
            if let Err(e) = std::fs::write(&failed, failed_lines.join("\n") + "\n") {
                eprintln!("dispatcher: could not write {}: {e}", failed.display());
            } else {
                eprintln!(
                    "dispatcher: kept {} failed line(s) in {}",
                    failed_lines.len(),
                    failed.display()
                );
            }
        }
        let done = path.with_extension("done");
        let _ = std::fs::rename(&working, &done);
    }
    Ok(processed)
}

/// Build + deliver the compact inbox digest for every recipient that has
/// deferred cards; mark exactly the included cards delivered.
fn digest_pass(
    board: &Board,
    roster: &Roster,
    transport: &dyn CardTransport,
    max_items: usize,
) -> Result<(), String> {
    let recipients = board_recipients(board)?;
    for recipient in recipients {
        if !roster.is_active_agent(&recipient) {
            continue;
        }
        let deferred = board
            .deferred_for(&recipient, now_ms())
            .map_err(|e| e.to_string())?;
        if deferred.is_empty() {
            continue;
        }
        let d = digest::build(&recipient, &deferred, max_items);
        let envelope = Envelope {
            schema_version: RPC_SCHEMA_VERSION,
            id: uuid::Uuid::new_v4().to_string(),
            kind: EnvelopeType::Event,
            method: Some(METHOD_INBOX_DIGEST.into()),
            agent: recipient.clone(),
            task_id: None,
            in_reply_to: None,
            payload: Some(serde_json::json!({
                "digest": d,
                "text": digest::render_text(&d),
            })),
            error: None,
            ts: now_rfc3339(),
            deadline_ms: None,
        };
        envelope.validate()?;
        transport.deliver(&envelope)?;
        board
            .mark_delivered(&d.included_card_ids, now_ms())
            .map_err(|e| e.to_string())?;
        eprintln!(
            "dispatcher: digest → {recipient} ({} of {} items)",
            d.items.len(),
            d.total_deferred
        );
    }
    Ok(())
}

fn board_recipients(board: &Board) -> Result<Vec<String>, String> {
    board
        .distinct_deferred_recipients()
        .map_err(|e| e.to_string())
}
