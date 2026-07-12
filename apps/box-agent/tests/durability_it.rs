//! Durability integration tests — the properties the codex + adversarial
//! reviews demanded, exercised against the real Inbox + WorkerPool on temp
//! dirs/DBs (no live services).

use box_agent::inbox::{commit_spool, take_spool, Accept, Inbox};
use box_agent::worker::WorkerPool;
use dispatcher::card::{InterruptPolicy, SenderClass, TaskCard};

fn card(id: &str, task_id: i64) -> TaskCard {
    TaskCard {
        schema_version: 1,
        card_id: id.into(),
        task_id,
        sender: "dispatcher".into(),
        sender_class: SenderClass::System,
        recipient: "box-a".into(),
        priority: 2,
        thread: None,
        requires_reply: false,
        interrupt_policy: InterruptPolicy::Defer,
        body: "b".into(),
        capability: None,
        lease: None,
        created_at: "2026-07-12T11:00:00Z".into(),
        expires_at: None,
    }
}

/// A card accepted while slots are full survives a restart and then runs —
/// the queue is the durable table, not memory (codex P1 / adversarial #1).
#[test]
fn queued_card_survives_restart_and_runs() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("inbox.db");

    // Boot 1: two cards accepted, only one slot — one runs, one queues durably.
    {
        let inbox = Inbox::open(&db).unwrap();
        inbox.enqueue_card(&card("c1", 1), "req-1", 0).unwrap();
        inbox.enqueue_card(&card("c2", 2), "req-2", 1).unwrap();
        let mut pool = WorkerPool::new(vec!["sleep".into(), "30".into()], 1);
        // Drive from pending: c1 starts, c2 has no room.
        let pending = inbox.load_pending().unwrap();
        assert_eq!(pending.len(), 2);
        for pc in &pending {
            if pool.has_room_for(&pc.card) {
                pool.spawn(pc.card.clone(), pc.request_id.clone(), 0)
                    .unwrap();
            }
        }
        assert_eq!(pool.running_count(), 1);
        pool.shutdown(); // simulate a crash/restart killing the running worker
    }

    // Boot 2: both cards are STILL pending (the running one wasn't completed).
    let inbox = Inbox::open(&db).unwrap();
    assert_eq!(
        inbox.pending_count().unwrap(),
        2,
        "no card lost across restart"
    );
    let mut pool = WorkerPool::new(vec!["true".into()], 2);
    for pc in inbox.load_pending().unwrap() {
        pool.spawn(pc.card.clone(), pc.request_id.clone(), 0)
            .unwrap();
    }
    let mut done = Vec::new();
    for _ in 0..200 {
        for f in pool.reap(0) {
            inbox.complete_card(&f.card.card_id).unwrap();
            done.push(f.card.card_id);
        }
        if done.len() == 2 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    done.sort();
    assert_eq!(done, vec!["c1", "c2"]);
    assert_eq!(
        inbox.pending_count().unwrap(),
        0,
        "both completed and cleared"
    );
}

/// A card redelivered under a fresh envelope id after being accepted is NOT
/// run twice (card-level dedup is the durable pending row).
#[test]
fn redelivered_card_does_not_run_twice() {
    let dir = tempfile::tempdir().unwrap();
    let inbox = Inbox::open(&dir.path().join("inbox.db")).unwrap();
    assert_eq!(
        inbox.enqueue_card(&card("c1", 1), "req-1", 0).unwrap(),
        Accept::Fresh
    );
    // Redelivery: same card_id, different envelope id.
    assert_eq!(
        inbox.enqueue_card(&card("c1", 1), "req-2", 5).unwrap(),
        Accept::Duplicate
    );
    assert_eq!(inbox.pending_count().unwrap(), 1, "exactly one work item");
}

/// A crash between take_spool and commit_spool re-reads the same envelopes
/// (no loss), and fresh envelopes appended meanwhile are folded in, not
/// clobbered (adversarial #2).
#[test]
fn spool_crash_recovery_loses_nothing() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("box-a.outbox.jsonl"), "a\nb\n").unwrap();

    // Take, then "crash" before commit.
    let batch1 = take_spool(dir.path(), "box-a").unwrap();
    assert_eq!(batch1, vec!["a", "b"]);
    // Meanwhile the dispatcher appends a new envelope.
    std::fs::write(dir.path().join("box-a.outbox.jsonl"), "c\n").unwrap();

    // Restart: the recovered .working (a, b) AND the fresh c are all returned.
    let batch2 = take_spool(dir.path(), "box-a").unwrap();
    assert!(batch2.contains(&"a".to_string()));
    assert!(batch2.contains(&"b".to_string()));
    assert!(
        batch2.contains(&"c".to_string()),
        "fresh envelope not clobbered"
    );
    commit_spool(dir.path(), "box-a");
    assert!(take_spool(dir.path(), "box-a").unwrap().is_empty());
}
