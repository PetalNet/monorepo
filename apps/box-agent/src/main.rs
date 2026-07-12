//! Box-agent daemon: consume the inbox spool (task.dispatch and friends),
//! run workers, answer with response envelopes, report capacity, and write
//! fleet-event snapshots.

use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use box_agent::config::Config;
use box_agent::events::{self, EventKind, FleetEvent, Status, FLEET_EVENT_SCHEMA_VERSION};
use box_agent::inbox::{take_spool_lines, Accept, Inbox};
use box_agent::worker::WorkerPool;
use dispatcher::card::TaskCard;
use dispatcher::deliver::{CardTransport, SpoolTransport};
use dispatcher::envelope::{Envelope, EnvelopeType, METHOD_TASK_DISPATCH, RPC_SCHEMA_VERSION};
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

    let started_at = now_rfc3339();
    eprintln!(
        "box-agent: up (handle {}, {} slots, inbox {})",
        cfg.handle,
        cfg.max_workers,
        cfg.inbox_dir.display()
    );
    emit_fleet_event(&cfg, &pool, EventKind::SessionStart, &started_at)?;
    report_capacity(&cfg, &pool, &transport)?;

    let mut last_capacity = Instant::now();
    let mut last_free_slots = pool.free_slots();

    loop {
        let mut activity = false;

        // 1. Inbox: envelopes addressed to us.
        for line in take_spool_lines(&cfg.inbox_dir, &cfg.handle)? {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<Envelope>(line) {
                Ok(envelope) => {
                    if let Err(e) = handle_envelope(&cfg, &inbox, &mut pool, envelope) {
                        eprintln!("box-agent: envelope refused: {e}");
                    }
                    activity = true;
                }
                Err(e) => eprintln!("box-agent: unparsable inbox line: {e}"),
            }
        }

        // 2. Reap finished workers → response envelopes.
        for finished in pool.reap(now_epoch()) {
            activity = true;
            let ok = finished.exit_code == Some(0);
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
                    "ran_secs": now_epoch() - finished.started_epoch,
                })),
                error: None,
                ts: now_rfc3339(),
                deadline_ms: None,
            };
            response.validate()?;
            transport.deliver(&response)?;
            eprintln!(
                "box-agent: worker for card {} finished (exit {:?})",
                finished.card.card_id, finished.exit_code
            );
            emit_fleet_event(&cfg, &pool, EventKind::PostTool, &started_at)?;
        }

        // 3. Capacity: on interval AND on slot change (BA7).
        let free = pool.free_slots();
        if free != last_free_slots
            || last_capacity.elapsed() >= Duration::from_secs(cfg.capacity_interval_secs)
        {
            last_free_slots = free;
            last_capacity = Instant::now();
            report_capacity(&cfg, &pool, &transport)?;
            emit_fleet_event(
                &cfg,
                &pool,
                if pool.running_count() > 0 {
                    EventKind::PreTool
                } else {
                    EventKind::PostTool
                },
                &started_at,
            )?;
        }

        if !activity {
            std::thread::sleep(Duration::from_millis(300));
        }
    }
}

fn handle_envelope(
    cfg: &Config,
    inbox: &Inbox,
    pool: &mut WorkerPool,
    envelope: Envelope,
) -> Result<(), String> {
    envelope.validate()?;
    if envelope.agent != cfg.handle {
        return Err(format!(
            "envelope for {:?} landed in {:?}'s inbox — dropped",
            envelope.agent, cfg.handle
        ));
    }
    if inbox.accept_envelope(&envelope, now_ms())? == Accept::Duplicate {
        return Ok(()); // redelivery: acknowledged by silence, not re-run
    }
    match (&envelope.kind, envelope.method.as_deref()) {
        (EnvelopeType::Request, Some(METHOD_TASK_DISPATCH)) => {
            let payload = envelope.payload.ok_or("task.dispatch without payload")?;
            let card: TaskCard =
                serde_json::from_value(payload["card"].clone()).map_err(|e| e.to_string())?;
            if inbox.accept_card(&card.card_id, now_ms())? == Accept::Duplicate {
                return Ok(());
            }
            let spawned = pool.accept(card, envelope.id, now_epoch())?;
            eprintln!(
                "box-agent: accepted card ({}, {} running, {} queued)",
                if spawned { "spawned" } else { "queued" },
                pool.running_count(),
                pool.queued_count()
            );
            Ok(())
        }
        (EnvelopeType::Event, Some("inbox.digest")) => {
            // Surfaced to the (human/agent) session out of band; the box-agent
            // just logs receipt — a digest is informational, not work.
            eprintln!("box-agent: inbox digest received");
            Ok(())
        }
        (EnvelopeType::Event, Some(m @ ("governance.action" | "fleet.mode"))) => {
            eprintln!("box-agent: {m} noted: {:?}", envelope.payload);
            Ok(())
        }
        (EnvelopeType::Heartbeat, _) => Ok(()),
        (kind, method) => Err(format!("unhandled envelope {kind:?} {method:?}")),
    }
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
    envelope.validate()?;
    transport.deliver(&envelope)
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
    events::write_snapshot(
        dir,
        &FleetEvent {
            schema_version: FLEET_EVENT_SCHEMA_VERSION,
            handle: cfg.handle.clone(),
            host: cfg.host.clone(),
            event,
            status: if focus.is_some() {
                Status::Working
            } else {
                Status::Idle
            },
            current_tool: None,
            task_id: focus.map(|c| c.task_id),
            session_id: None,
            started_at: started_at.to_string(),
            updated_at: now_rfc3339(),
        },
    )
}
