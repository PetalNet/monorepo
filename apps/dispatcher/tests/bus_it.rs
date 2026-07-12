//! End-to-end bus tests: the whole dispatch path on temp dirs/DBs, plus the
//! concurrency property the board's CAS claim guarantees. No live service,
//! no live DB, no network — disposable-agent style (§0).

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};

use dispatcher::board::{Board, BoardError, NewCard};
use dispatcher::card::{InterruptPolicy, SenderClass};
use dispatcher::deliver::SpoolTransport;
use dispatcher::digest;
use dispatcher::dispatch::{Dispatcher, InboundMessage};
use dispatcher::envelope::Envelope;
use dispatcher::roster::{AgentEntry, Roster};
use dispatcher::tracker::{SqliteTracker, Tracker};
use dispatcher::wake::TokenBucket;

fn test_roster() -> Roster {
    let mut r = Roster::new(vec!["@parker:petalnet.example".to_string()], vec![]);
    for handle in ["janet", "box-a", "box-b"] {
        r.upsert_agent(AgentEntry {
            handle: handle.into(),
            capabilities: ["code".to_string()].into_iter().collect(),
            active: true,
        });
    }
    r
}

/// The full path: principal Matrix message → task filed in a temp tracker →
/// interrupt delivered to the recipient's outbox spool as a valid
/// backchannel-rpc envelope carrying a contract-valid task card.
#[test]
fn end_to_end_interrupt_reaches_the_spool() {
    let dir = tempfile::tempdir().unwrap();
    let board = Board::open(&dir.path().join("board.db")).unwrap();
    let tracker = SqliteTracker::open(&dir.path().join("tasks.db")).unwrap();
    tracker.init_test_schema().unwrap();
    let roster = test_roster();
    let outbox = dir.path().join("outbox");
    let transport = SpoolTransport::new(outbox.clone());

    let mut d = Dispatcher {
        board: &board,
        roster: &roster,
        tracker: Some(&tracker as &dyn Tracker),
        transport: &transport,
        wake_bucket: TokenBucket::new(10.0, 10.0, 0),
        lease_ms: 60_000,
    };

    let msg = InboundMessage {
        sender: "@parker:petalnet.example".into(),
        recipient: Some("janet".into()),
        task_id: None, // brand-new work: the dispatcher must file the task first
        body: "drop what you're doing and check the backups".into(),
        priority: Some(0),
        thread: Some("$threadroot".into()),
        requires_reply: true,
        interrupt_policy: InterruptPolicy::PrincipalCommand,
        needs: BTreeSet::new(),
        reply_to: None,
        dedupe_key: Some("$matrix-event-abc123".into()),
    };
    let routed = d.dispatch(&msg, 1_000, "2026-07-12T12:00:00Z").unwrap();

    // The task exists in the tracker (spawn-from-task).
    let filed = tracker.active_lease("janet").unwrap();
    assert!(filed.is_none(), "filed as todo, not leased");

    // The spool has exactly one valid envelope with the card inside.
    let spool = std::fs::read_to_string(outbox.join("janet.outbox.jsonl")).unwrap();
    let lines: Vec<&str> = spool.lines().collect();
    assert_eq!(lines.len(), 1);
    let env: Envelope = serde_json::from_str(lines[0]).unwrap();
    env.validate().unwrap();
    assert_eq!(env.method.as_deref(), Some("task.dispatch"));
    let card: dispatcher::card::TaskCard =
        serde_json::from_value(env.payload.unwrap()["card"].clone()).unwrap();
    assert_eq!(card.sender_class, SenderClass::Principal);
    assert_eq!(card.interrupt_policy, InterruptPolicy::PrincipalCommand);
    assert_eq!(card.recipient, "janet");
    assert!(card.task_id >= 1);
    assert_eq!(card.body, msg.body, "body is forwarded verbatim");
    match routed {
        dispatcher::dispatch::Routed::Interrupted { envelope_id, .. } => {
            assert_eq!(envelope_id, env.id)
        }
        other => panic!("expected interrupt, got {other:?}"),
    }
}

/// N workers race for M cards: every card is claimed exactly once, no worker
/// ever sees a double-win, and losers back off onto other cards.
#[test]
fn concurrent_claims_are_exactly_once() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("board.db");
    let board = Board::open(&db_path).unwrap();

    const CARDS: usize = 40;
    const WORKERS: usize = 8;
    let mut ids = Vec::new();
    for i in 0..CARDS {
        let id = board
            .post(
                &NewCard {
                    task_id: i as i64 + 1,
                    sender: "dispatcher".into(),
                    sender_class: SenderClass::System,
                    recipient: None,
                    priority: (i % 4) as u8,
                    thread: None,
                    requires_reply: false,
                    interrupt_policy: InterruptPolicy::Defer,
                    body: format!("job {i}"),
                    needs: BTreeSet::new(),
                    reply_to: None,
                    parent_id: None,
                },
                0,
            )
            .unwrap();
        ids.push(id);
    }
    drop(board);

    let claimed: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let conflicts = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(Barrier::new(WORKERS));
    let mut handles = Vec::new();
    for w in 0..WORKERS {
        let claimed = claimed.clone();
        let conflicts = conflicts.clone();
        let barrier = barrier.clone();
        let db_path = db_path.clone();
        let ids = ids.clone();
        handles.push(std::thread::spawn(move || {
            let board = Board::open(&db_path).unwrap();
            let worker = format!("worker-{w}");
            barrier.wait();
            // Each worker walks the full card list, racing claims.
            for id in &ids {
                match board.claim(id, &worker, 60_000, 1) {
                    Ok(card) => {
                        claimed.lock().unwrap().push((card.card_id, worker.clone()));
                    }
                    Err(BoardError::Conflict(_)) => {
                        conflicts.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => panic!("unexpected error: {e}"),
                }
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    let claimed = claimed.lock().unwrap();
    assert_eq!(claimed.len(), CARDS, "every card claimed");
    let mut unique: Vec<&String> = claimed.iter().map(|(id, _)| id).collect();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), CARDS, "no card claimed twice");
    assert_eq!(
        conflicts.load(Ordering::Relaxed),
        CARDS * (WORKERS - 1),
        "every non-winner got a clean conflict"
    );
}

/// Pull-mode worker loop: surface → claim → complete, honoring the
/// capability gate; digest sweeps the leftovers.
#[test]
fn pull_workers_and_digest_cover_the_board() {
    let dir = tempfile::tempdir().unwrap();
    let board = Board::open(&dir.path().join("board.db")).unwrap();

    // Two pool cards a code worker can take, one gpu card nobody here can.
    for (needs, task_id) in [(vec!["code"], 1i64), (vec!["code"], 2), (vec!["gpu"], 3)] {
        board
            .post(
                &NewCard {
                    task_id,
                    sender: "dispatcher".into(),
                    sender_class: SenderClass::System,
                    recipient: None,
                    priority: 1,
                    thread: None,
                    requires_reply: false,
                    interrupt_policy: InterruptPolicy::Defer,
                    body: format!("task {task_id}"),
                    needs: needs.into_iter().map(String::from).collect(),
                    reply_to: None,
                    parent_id: None,
                },
                0,
            )
            .unwrap();
    }
    // One deferred card addressed to janet (digest material).
    board
        .post(
            &NewCard {
                task_id: 9,
                sender: "@parker:petalnet.example".into(),
                sender_class: SenderClass::Principal,
                recipient: Some("janet".into()),
                priority: 2,
                thread: None,
                requires_reply: false,
                interrupt_policy: InterruptPolicy::Defer,
                body: "when you get a chance, tidy the logs".into(),
                needs: BTreeSet::new(),
                reply_to: None,
                parent_id: None,
            },
            0,
        )
        .unwrap();

    // A code worker drains everything it's eligible for (prefetch=1 each cycle).
    let provides: BTreeSet<String> = ["code".to_string()].into_iter().collect();
    let mut done = 0;
    while let Some(card) = board.surface("box-a", &provides, 10_000).unwrap() {
        let claimed = board.claim(&card.card_id, "box-a", 60_000, 10_000).unwrap();
        board
            .complete(&claimed.card_id, "box-a", claimed.fence, Some("ok"), 11_000)
            .unwrap();
        done += 1;
    }
    assert_eq!(done, 2, "both code cards drained; gpu card never surfaced");

    // janet's addressed card also surfaces to janet in pull mode — but here it
    // goes out via the digest instead.
    let deferred = board.deferred_for("janet", 0).unwrap();
    assert_eq!(deferred.len(), 1);
    let d = digest::build("janet", &deferred, 10);
    assert_eq!(d.items.len(), 1);
    assert!(digest::render_text(&d).contains("tidy the logs"));
    board.mark_delivered(&d.included_card_ids, 12_000).unwrap();
    assert!(
        board.deferred_for("janet", 0).unwrap().is_empty(),
        "digest marks delivered"
    );
    assert_eq!(board.distinct_deferred_recipients().unwrap().len(), 0);

    // The gpu card has no eligible agent right now: PARK it (blocked-evals
    // style), verify it stops surfacing even to a capable worker, then wake
    // it on a capacity-change event and claim it through the real pull path.
    let gpu_provides: BTreeSet<String> = ["gpu".to_string()].into_iter().collect();
    let gpu_card = board
        .surface("box-a", &gpu_provides, 20_000)
        .unwrap()
        .unwrap();
    board.park(&gpu_card.card_id, 20_000).unwrap();
    assert!(
        board
            .surface("box-a", &gpu_provides, 21_000)
            .unwrap()
            .is_none(),
        "parked cards never surface"
    );
    assert_eq!(
        board.wake_parked(22_000).unwrap(),
        1,
        "capacity change wakes it"
    );
    let woken = board
        .surface("box-a", &gpu_provides, 23_000)
        .unwrap()
        .unwrap();
    assert_eq!(woken.card_id, gpu_card.card_id);
    let claimed = board
        .claim(&woken.card_id, "box-a", 60_000, 23_000)
        .unwrap();
    board
        .complete(&claimed.card_id, "box-a", claimed.fence, Some("ok"), 24_000)
        .unwrap();
}
