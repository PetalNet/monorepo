//! Control-plane daemon: consume inbound envelopes (agent.capacity,
//! usage.report), keep the registry fresh, run governance + discipline
//! ticks, and emit actions as envelopes on the outbound spool (the doorman
//! client replaces the spool at N1.4 integration — CP11).

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use control_plane::config::Config;
use control_plane::discipline::{nag_body, AgentActivity, Discipline};
use control_plane::governance::{Action, Governor, Tier, Usage};
use control_plane::registry::{CapacityReport, Registry};
use control_plane::tokens::TokenAuthority;
use control_plane::vault::FileVault;
use dispatcher::deliver::{CardTransport, SpoolTransport};
use dispatcher::envelope::{Envelope, EnvelopeType, RPC_SCHEMA_VERSION};
use dispatcher::glitchtip;

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn main() {
    let config_path = std::env::var("CONTROL_PLANE_CONFIG")
        .unwrap_or_else(|_| "control-plane-config.json".to_string());
    let cfg = match Config::load(Path::new(&config_path)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("control-plane: config error: {e}");
            std::process::exit(2);
        }
    };
    if let Some(dsn) = &cfg.glitchtip_dsn {
        if let Err(e) = glitchtip::init(dsn) {
            eprintln!("control-plane: glitchtip disabled: {e}");
        }
    }
    if let Err(e) = run(cfg) {
        glitchtip::capture_message(&format!("control-plane exiting on error: {e}"), "error");
        eprintln!("control-plane: {e}");
        std::process::exit(1);
    }
}

fn run(cfg: Config) -> Result<(), String> {
    let registry = Registry::open(&cfg.db_path)?;
    let vault = FileVault::open(&cfg.vault_dir)?;
    let _authority = TokenAuthority { store: &vault }; // exercised via RPC methods as they land
    let mut governor = Governor::new(cfg.pool_tokens);
    let discipline = Discipline {
        grace_secs: cfg.discipline_grace_secs,
    };

    let ingest_dir = cfg
        .ingest_dir
        .clone()
        .ok_or("ingest_dir is required for the spool runtime")?;
    std::fs::create_dir_all(&ingest_dir).map_err(|e| e.to_string())?;
    let outbox = cfg
        .outbox_dir
        .clone()
        .ok_or("outbox_dir is required for the spool runtime")?;
    let transport = SpoolTransport::new(outbox);

    // Crash recovery, same semantics as the dispatcher: at-least-once.
    for entry in std::fs::read_dir(&ingest_dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("working") {
            let _ = std::fs::rename(&path, path.with_extension("jsonl"));
        }
    }

    eprintln!(
        "control-plane: up (registry {}, vault {}, pool {} tokens)",
        cfg.db_path.display(),
        cfg.vault_dir.display(),
        cfg.pool_tokens
    );

    // Discipline needs a REAL lease lookup (codex P1: an event's task_id is
    // not lease state); without a tracker path the pass is disabled.
    let discipline_tracker: Option<dispatcher::tracker::SqliteTracker> = match &cfg.tracker_db_path
    {
        Some(p) => Some(dispatcher::tracker::SqliteTracker::open(p)?),
        None => {
            eprintln!("control-plane: no tracker_db_path — discipline pass disabled");
            None
        }
    };

    let mut usages: BTreeMap<String, Usage> = BTreeMap::new();
    let mut tiers: BTreeMap<String, Tier> = BTreeMap::new();
    let mut nagged: BTreeMap<String, i64> = BTreeMap::new();
    let mut last_actions: BTreeMap<String, Action> = BTreeMap::new();
    // handle → (last seen status, epoch it ENTERED that status) — the
    // working-grace timer keys on the transition, not session start (codex P2).
    let mut status_since: BTreeMap<String, (String, i64)> = BTreeMap::new();
    let mut fleet_sequential = false;
    let mut last_governance = Instant::now();

    loop {
        let processed = ingest_pass(
            &ingest_dir,
            &registry,
            &mut usages,
            &mut tiers,
            &mut governor,
            &cfg,
        )?;

        if last_governance.elapsed() >= Duration::from_secs(cfg.governance_interval_secs) {
            last_governance = Instant::now();
            governance_pass(
                &governor,
                &usages,
                &mut tiers,
                &registry,
                &transport,
                &mut last_actions,
                &mut fleet_sequential,
            )?;
            if let Some(tracker) = &discipline_tracker {
                discipline_pass(
                    &cfg,
                    &discipline,
                    &registry,
                    tracker,
                    &transport,
                    &mut nagged,
                    &mut status_since,
                )?;
            }
        }

        if processed == 0 {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

/// Consume inbound envelope spool files: agent.capacity updates the registry
/// (and auto-grants a budget lease to newly seen agents); usage.report feeds
/// governance.
fn ingest_pass(
    dir: &Path,
    registry: &Registry,
    usages: &mut BTreeMap<String, Usage>,
    tiers: &mut BTreeMap<String, Tier>,
    governor: &mut Governor,
    cfg: &Config,
) -> Result<usize, String> {
    let mut processed = 0;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let working = path.with_extension("working");
        if std::fs::rename(&path, &working).is_err() {
            continue;
        }
        let content = std::fs::read_to_string(&working).map_err(|e| e.to_string())?;
        let mut failed: Vec<&str> = Vec::new();
        for line in content.lines().map(str::trim).filter(|l| !l.is_empty()) {
            match handle_envelope(line, registry, usages, tiers, governor, cfg) {
                Ok(()) => processed += 1,
                Err(e) => {
                    eprintln!("control-plane: envelope refused: {e}");
                    failed.push(line);
                }
            }
        }
        if !failed.is_empty() {
            let _ = std::fs::write(path.with_extension("failed"), failed.join("\n") + "\n");
        }
        let _ = std::fs::rename(&working, path.with_extension("done"));
    }
    Ok(processed)
}

fn handle_envelope(
    line: &str,
    registry: &Registry,
    usages: &mut BTreeMap<String, Usage>,
    tiers: &mut BTreeMap<String, Tier>,
    governor: &mut Governor,
    cfg: &Config,
) -> Result<(), String> {
    let envelope: Envelope = serde_json::from_str(line).map_err(|e| e.to_string())?;
    envelope.validate()?;
    let now = now_epoch();
    match envelope.method.as_deref() {
        Some("agent.capacity") => {
            let payload = envelope.payload.ok_or("agent.capacity without payload")?;
            let report: CapacityReport =
                serde_json::from_value(payload).map_err(|e| e.to_string())?;
            if report.handle != envelope.agent {
                return Err(format!(
                    "capacity handle {:?} != envelope agent {:?}",
                    report.handle, envelope.agent
                ));
            }
            registry.report(&report, now)?;
            // Grant whenever the agent holds no LIVE lease — this covers
            // first sight, natural expiry, AND a control-plane restart
            // (codex P1: grants are in-memory; a restart must re-grant, not
            // strand every known agent on Red/Pause forever).
            if !governor.has_live_grant(&report.handle, now) {
                match governor.grant(
                    &report.handle,
                    cfg.default_grant_tokens,
                    cfg.grant_lease_secs,
                    now,
                ) {
                    Ok(g) => eprintln!(
                        "control-plane: granted {} a {}-token lease",
                        g.agent, g.granted_tokens
                    ),
                    Err(e) => eprintln!("control-plane: no grant for {}: {e}", report.handle),
                }
            }
            Ok(())
        }
        Some("usage.report") => {
            let payload = envelope.payload.ok_or("usage.report without payload")?;
            let usage: Usage = serde_json::from_value(payload).map_err(|e| e.to_string())?;
            // The agent's manager self-reports its CURRENT tier — trust that
            // over any stale assumption (codex P1: a Haiku agent must never
            // receive a downgrade-to-Sonnet "upgrade"). Opus only as the
            // never-reported fallback.
            if let Some(tier) = usage.tier {
                tiers.insert(envelope.agent.clone(), tier);
            } else {
                tiers.entry(envelope.agent.clone()).or_insert(Tier::Opus);
            }
            usages.insert(envelope.agent, usage);
            Ok(())
        }
        other => Err(format!("unhandled method {other:?}")),
    }
}

/// Evaluate every reporting agent; emit `governance.action` envelopes for
/// anything non-None — EDGE-triggered (only when the decision changes for
/// that agent), so a persisting yellow doesn't spam a downgrade per tick.
/// Also flags fleet-sequential mode when the cascade detector trips.
fn governance_pass(
    governor: &Governor,
    usages: &BTreeMap<String, Usage>,
    tiers: &mut BTreeMap<String, Tier>,
    registry: &Registry,
    transport: &dyn CardTransport,
    last_actions: &mut BTreeMap<String, Action>,
    fleet_sequential: &mut bool,
) -> Result<(), String> {
    let now = now_epoch();
    for (agent, usage) in usages {
        let tier = tiers.get(agent).copied().unwrap_or(Tier::Opus);
        let action = governor.decide(agent, usage, tier, now);
        let unchanged = last_actions.get(agent) == Some(&action);
        last_actions.insert(agent.clone(), action.clone());
        if action == Action::None || unchanged {
            continue;
        }
        deliver_event(
            transport,
            agent,
            "governance.action",
            serde_json::to_value(&action).map_err(|e| e.to_string())?,
        )?;
        // Track the tier we just instructed, so a persisting yellow steps
        // down one tier per decision change instead of re-targeting Sonnet
        // forever (the agent's next usage.report confirms or corrects).
        if let Action::Downgrade { to } = &action {
            tiers.insert(agent.clone(), *to);
        }
        eprintln!("control-plane: {agent} → {action:?}");
    }

    // Cascade: fleet mode is APPLIED, not just logged (codex P1) — an
    // edge-triggered fleet.mode event goes to every alive agent, both when
    // sequential engages and when it releases.
    let sequential =
        governor.fleet_mode(usages, now) == control_plane::governance::FleetMode::Sequential;
    if sequential != *fleet_sequential {
        *fleet_sequential = sequential;
        let mode = if sequential { "sequential" } else { "parallel" };
        if sequential {
            glitchtip::capture_message("cascade detected: fleet → sequential mode", "warning");
        }
        eprintln!("control-plane: fleet mode → {mode}");
        for entry in registry.all(now)? {
            if entry.liveness != control_plane::registry::Liveness::Down {
                deliver_event(
                    transport,
                    &entry.handle,
                    "fleet.mode",
                    serde_json::json!({ "mode": mode }),
                )?;
            }
        }
    }
    Ok(())
}

fn deliver_event(
    transport: &dyn CardTransport,
    agent: &str,
    method: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let envelope = Envelope {
        schema_version: RPC_SCHEMA_VERSION,
        id: uuid::Uuid::new_v4().to_string(),
        kind: EnvelopeType::Event,
        method: Some(method.into()),
        agent: agent.to_string(),
        task_id: None,
        in_reply_to: None,
        payload: Some(payload),
        error: None,
        ts: now_rfc3339(),
        deadline_ms: None,
    };
    envelope.validate()?;
    transport.deliver(&envelope)
}

/// Read fleet-event snapshots (data/fleet/<handle>.json layout), check
/// discipline against the TRACKER's lease state (never the event's own
/// task_id — codex P1), and nag. Each agent is nagged at most once per hour.
/// The working-grace timer keys on the alive/idle→working TRANSITION we
/// observe, not the session's started_at (codex P2).
#[allow(clippy::too_many_arguments)]
fn discipline_pass(
    cfg: &Config,
    discipline: &Discipline,
    registry: &Registry,
    tracker: &dispatcher::tracker::SqliteTracker,
    transport: &dyn CardTransport,
    nagged: &mut BTreeMap<String, i64>,
    status_since: &mut BTreeMap<String, (String, i64)>,
) -> Result<(), String> {
    use dispatcher::tracker::Tracker as _;
    let Some(dir) = &cfg.fleet_events_dir else {
        return Ok(());
    };
    let now = now_epoch();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let handle = event["handle"].as_str().unwrap_or_default().to_string();
        if handle.is_empty() {
            continue;
        }
        let status = event["status"].as_str().unwrap_or("alive").to_string();
        // Grace timer: when did we first SEE this agent in its current status?
        let since = match status_since.get(&handle) {
            Some((prev, since)) if *prev == status => *since,
            _ => {
                status_since.insert(handle.clone(), (status.clone(), now));
                now
            }
        };
        let activity = AgentActivity {
            handle: handle.clone(),
            status,
            event_task_id: event["task_id"].as_i64(),
            working_since_epoch: since,
            active_lease: tracker.active_lease(&handle)?,
        };
        if let Some(violation) = discipline.check(&activity, now) {
            let last = nagged.get(&handle).copied().unwrap_or(0);
            if now - last < 3600 {
                continue;
            }
            if registry.get(&handle, now)?.is_none() {
                continue; // unknown to the fleet: nothing to nag
            }
            nagged.insert(handle.clone(), now);
            let envelope = Envelope {
                schema_version: RPC_SCHEMA_VERSION,
                id: uuid::Uuid::new_v4().to_string(),
                kind: EnvelopeType::Event,
                method: Some("discipline.nag".into()),
                agent: handle.clone(),
                task_id: activity.event_task_id,
                in_reply_to: None,
                payload: Some(serde_json::json!({
                    "violation": violation,
                    "body": nag_body(&violation),
                })),
                error: None,
                ts: now_rfc3339(),
                deadline_ms: None,
            };
            envelope.validate()?;
            transport.deliver(&envelope)?;
            eprintln!("control-plane: discipline nag → {handle}");
        }
    }
    Ok(())
}
