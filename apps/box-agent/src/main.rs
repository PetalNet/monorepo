//! Box-agent daemon: consume the inbox spool (task.dispatch and friends),
//! accept work into a DURABLE pending queue, run workers from that queue,
//! answer with response/error envelopes, report capacity, and write
//! fleet-event snapshots. The pending table is the source of truth — a
//! restart re-runs unfinished work and no card is lost.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use box_agent::config::Config;
use box_agent::events::{self, EventKind, FleetEvent, Status, FLEET_EVENT_SCHEMA_VERSION};
use box_agent::inbox::{commit_spool, take_spool, Accept, Inbox};
use box_agent::worker::WorkerPool;
use dispatcher::card::TaskCard;
use dispatcher::deliver::{CardTransport, SpoolTransport};
use dispatcher::envelope::{
    Envelope, EnvelopeType, RpcError, METHOD_TASK_DISPATCH, RPC_SCHEMA_VERSION,
};
use dispatcher::glitchtip;

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

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
        std::env::var("BOX_AGENT_CONFIG").unwrap_or_else(|_| "box-agent-config.json".to_string());
    let cfg = match Config::load(Path::new(&config_path)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("box-agent: config error: {e}");
            std::process::exit(2);
        }
    };
    if let Some(dsn) = &cfg.glitchtip_dsn {
        if let Err(e) = glitchtip::init(dsn) {
            eprintln!("box-agent: glitchtip disabled: {e}");
        }
    }
    if let Err(e) = run(cfg) {
        glitchtip::capture_message(&format!("box-agent exiting on error: {e}"), "error");
        eprintln!("box-agent: {e}");
        std::process::exit(1);
    }
}

fn run(cfg: Config) -> Result<(), String> {
    let inbox = Inbox::open(&cfg.db_path)?;
    let mut pool = WorkerPool::new(cfg.worker_cmd.clone(), cfg.max_workers);
    let transport = SpoolTransport::new(cfg.outbox_dir.clone());
    std::fs::create_dir_all(&cfg.inbox_dir).map_err(|e| e.to_string())?;

    // Graceful shutdown: emit Stop, kill workers.
    let shutdown = Arc::new(AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        let flag = shutdown.clone();
        signal_hook::flag::register(sig, flag).map_err(|e| e.to_string())?;
    }

    let started_at = now_rfc3339();
    eprintln!(
        "box-agent: up (handle {}, {} slots, {} pending from a prior run)",
        cfg.handle,
        cfg.max_workers,
        inbox.pending_count().unwrap_or(0)
    );
    emit_fleet_event(&cfg, &pool, EventKind::SessionStart, &started_at)?;
    report_capacity(&cfg, &pool, &transport)?;

    let mut last_capacity = Instant::now();
    let mut last_free_slots = pool.free_slots();
    let mut last_prune = Instant::now();
    // Keep dedup rows well past any plausible redelivery horizon.
    const SEEN_RETENTION_MS: i64 = 24 * 3600 * 1000;

    while !shutdown.load(Ordering::Relaxed) {
        let mut activity = false;

        // 1. Inbox: accept envelopes into the durable pending queue. The
        //    .working batch is committed only after every line is durably
        //    recorded (in `seen` or `pending`) — a crash re-reads it.
        let lines = take_spool(&cfg.inbox_dir, &cfg.handle)?;
        if !lines.is_empty() {
            activity = true;
            for line in lines {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Envelope>(line) {
                    Ok(envelope) => accept_envelope(&cfg, &inbox, &transport, envelope),
                    Err(e) => eprintln!("box-agent: unparsable inbox line: {e}"),
                }
            }
            commit_spool(&cfg.inbox_dir, &cfg.handle);
        }

        // 2. Drive the pool from the durable pending table (source of truth).
        for pc in inbox.load_pending()? {
            if pool.is_running(&pc.card.card_id) {
                continue;
            }
            if !pool.has_room_for(&pc.card) {
                continue;
            }
            match pool.spawn(pc.card.clone(), pc.request_id.clone(), now_epoch()) {
                Ok(()) => {
                    activity = true;
                    eprintln!(
                        "box-agent: started card {} ({} running)",
                        pc.card.card_id,
                        pool.running_count()
                    );
                }
                Err(e) => {
                    // Transient (binary redeploying): leave the row for retry.
                    eprintln!(
                        "box-agent: spawn for {} failed, will retry: {e}",
                        pc.card.card_id
                    );
                }
            }
        }

        // 3. Reap finished workers → response envelopes → clear pending rows.
        for finished in pool.reap(now_epoch()) {
            activity = true;
            let ok = finished.exit_code == Some(0) && !finished.timed_out;
            let response = Envelope {
                schema_version: RPC_SCHEMA_VERSION,
                id: uuid::Uuid::new_v4().to_string(),
                kind: EnvelopeType::Response,
                method: None,
                agent: cfg.handle.clone(),
                task_id: Some(finished.card.task_id),
                in_reply_to: Some(finished.request_id.clone()),
                payload: Some(serde_json::json!({
                    "card_id": finished.card.card_id,
                    "ok": ok,
                    "exit_code": finished.exit_code,
                    "timed_out": finished.timed_out,
                    "ran_secs": now_epoch() - finished.started_epoch,
                    "output_tail": finished.output_tail,
                })),
                error: None,
                ts: now_rfc3339(),
                deadline_ms: None,
            };
            // Emit the response, THEN clear the pending row. A per-item IO
            // failure is logged, not fatal (adversarial-review #4): the row
            // stays and the finished worker is already reaped, so the response
            // is regenerated from... nothing — so if delivery fails we keep the
            // row and re-emit on a later tick by re-detecting completion is not
            // possible (the child is gone). Instead: retry delivery a few times
            // inline; only clear on success. If it ultimately fails, leave the
            // row so a human sees stuck pending work rather than a silent drop.
            match deliver_with_retry(&transport, &response) {
                Ok(()) => {
                    inbox.complete_card(&finished.card.card_id)?;
                    eprintln!(
                        "box-agent: card {} done (exit {:?}, timed_out {})",
                        finished.card.card_id, finished.exit_code, finished.timed_out
                    );
                }
                Err(e) => {
                    glitchtip::capture_message(
                        &format!(
                            "response delivery for {} failed: {e}",
                            finished.card.card_id
                        ),
                        "error",
                    );
                    eprintln!("box-agent: response delivery failed, card stays pending: {e}");
                }
            }
            emit_fleet_event(&cfg, &pool, EventKind::PostTool, &started_at).ok();
        }

        // 4. Capacity: on interval AND on slot change (BA7).
        let free = pool.free_slots();
        if free != last_free_slots
            || last_capacity.elapsed() >= Duration::from_secs(cfg.capacity_interval_secs)
        {
            last_free_slots = free;
            last_capacity = Instant::now();
            report_capacity(&cfg, &pool, &transport).ok();
            emit_fleet_event(
                &cfg,
                &pool,
                if pool.running_count() > 0 {
                    EventKind::PreTool
                } else {
                    EventKind::PostTool
                },
                &started_at,
            )
            .ok();
        }

        if last_prune.elapsed() >= Duration::from_secs(3600) {
            last_prune = Instant::now();
            if let Ok(n) = inbox.prune_seen(now_ms() - SEEN_RETENTION_MS) {
                if n > 0 {
                    eprintln!("box-agent: pruned {n} stale dedup rows");
                }
            }
        }

        if !activity {
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    eprintln!(
        "box-agent: shutting down — killing {} worker(s)",
        pool.running_count()
    );
    pool.shutdown();
    emit_fleet_event(&cfg, &pool, EventKind::Stop, &started_at).ok();
    Ok(())
}

/// Accept one inbound envelope. Work is durably enqueued (or the envelope is
/// marked seen); a permanently-bad task.dispatch gets an Error response so the
/// caller isn't left hanging (adversarial-review #5).
fn accept_envelope(cfg: &Config, inbox: &Inbox, transport: &dyn CardTransport, envelope: Envelope) {
    if let Err(e) = envelope.validate() {
        eprintln!("box-agent: invalid envelope: {e}");
        return;
    }
    if envelope.agent != cfg.handle {
        eprintln!(
            "box-agent: envelope for {:?} in {:?}'s inbox — dropped",
            envelope.agent, cfg.handle
        );
        return;
    }
    match (&envelope.kind, envelope.method.as_deref()) {
        (EnvelopeType::Request, Some(METHOD_TASK_DISPATCH)) => {
            let card = match envelope
                .payload
                .as_ref()
                .and_then(|p| p.get("card"))
                .ok_or("task.dispatch without card payload")
                .and_then(|c| {
                    serde_json::from_value::<TaskCard>(c.clone()).map_err(|_| "malformed card")
                }) {
                Ok(c) => c,
                Err(reason) => {
                    // Permanent failure: tell the caller, mark seen so a
                    // redelivery of the same bad envelope isn't reprocessed.
                    let _ = inbox.mark_envelope(&envelope.id, now_ms());
                    send_error(transport, cfg, &envelope, "bad_request", reason, false);
                    return;
                }
            };
            // enqueue_card is idempotent on card_id and IS the durable accept;
            // record the envelope seen only after the card is durably queued.
            match inbox.enqueue_card(&card, &envelope.id, now_ms()) {
                Ok(Accept::Fresh) => {
                    let _ = inbox.mark_envelope(&envelope.id, now_ms());
                    eprintln!("box-agent: enqueued card {}", card.card_id);
                }
                Ok(Accept::Duplicate) => {
                    let _ = inbox.mark_envelope(&envelope.id, now_ms());
                }
                Err(e) => eprintln!("box-agent: enqueue failed (will re-read spool): {e}"),
            }
        }
        (EnvelopeType::Event, Some("inbox.digest")) => {
            let _ = inbox.mark_envelope(&envelope.id, now_ms());
            eprintln!("box-agent: inbox digest received");
        }
        (EnvelopeType::Event, Some(m @ ("governance.action" | "fleet.mode"))) => {
            let _ = inbox.mark_envelope(&envelope.id, now_ms());
            eprintln!("box-agent: {m} noted: {:?}", envelope.payload);
        }
        (EnvelopeType::Heartbeat, _) => {
            let _ = inbox.mark_envelope(&envelope.id, now_ms());
        }
        (kind, method) => {
            let _ = inbox.mark_envelope(&envelope.id, now_ms());
            eprintln!("box-agent: unhandled envelope {kind:?} {method:?}");
        }
    }
}

fn send_error(
    transport: &dyn CardTransport,
    cfg: &Config,
    request: &Envelope,
    code: &str,
    message: &str,
    retryable: bool,
) {
    let err = Envelope {
        schema_version: RPC_SCHEMA_VERSION,
        id: uuid::Uuid::new_v4().to_string(),
        kind: EnvelopeType::Error,
        method: None,
        agent: cfg.handle.clone(),
        task_id: request.task_id,
        in_reply_to: Some(request.id.clone()),
        payload: None,
        error: Some(RpcError {
            code: code.into(),
            message: message.into(),
            retryable,
        }),
        ts: now_rfc3339(),
        deadline_ms: None,
    };
    if let Err(e) = deliver_with_retry(transport, &err) {
        eprintln!("box-agent: error-response delivery failed: {e}");
    }
}

fn deliver_with_retry(transport: &dyn CardTransport, envelope: &Envelope) -> Result<(), String> {
    envelope.validate()?;
    let mut last = String::new();
    for attempt in 0..3 {
        match transport.deliver(envelope) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e;
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(100 * (attempt as u64 + 1)));
                }
            }
        }
    }
    Err(last)
}

fn report_capacity(
    cfg: &Config,
    pool: &WorkerPool,
    transport: &dyn CardTransport,
) -> Result<(), String> {
    let envelope = Envelope {
        schema_version: RPC_SCHEMA_VERSION,
        id: uuid::Uuid::new_v4().to_string(),
        kind: EnvelopeType::Event,
        method: Some(dispatcher::envelope::METHOD_AGENT_CAPACITY.into()),
        agent: cfg.handle.clone(),
        task_id: None,
        in_reply_to: None,
        payload: Some(serde_json::json!({
            "handle": cfg.handle,
            "provides": cfg.provides,
            "free_slots": pool.free_slots(),
            "host": cfg.host,
        })),
        error: None,
        ts: now_rfc3339(),
        deadline_ms: None,
    };
    deliver_with_retry(transport, &envelope)
}

fn emit_fleet_event(
    cfg: &Config,
    pool: &WorkerPool,
    event: EventKind,
    started_at: &str,
) -> Result<(), String> {
    let Some(dir) = &cfg.fleet_dir else {
        return Ok(());
    };
    let focus = pool.focus();
    let status = match event {
        EventKind::Stop => Status::Idle,
        _ if focus.is_some() => Status::Working,
        _ => Status::Idle,
    };
    events::write_snapshot(
        dir,
        &FleetEvent {
            schema_version: FLEET_EVENT_SCHEMA_VERSION,
            handle: cfg.handle.clone(),
            host: cfg.host.clone(),
            event,
            status,
            current_tool: None,
            task_id: focus.map(|c| c.task_id),
            session_id: None,
            started_at: started_at.to_string(),
            updated_at: now_rfc3339(),
        },
    )
}
