//! The dispatch core: inbound message → tracker task → enforced card →
//! interrupt delivery or board queueing (CONTRACTS §4, §8).
//!
//! Flow per inbound message:
//! 1. Stamp `sender_class` from the roster (never trusted from the sender).
//! 2. Resolve the tracker task: carry the given task_id, or FILE a task first
//!    (spawn-from-task — a card about new work exists only after its task).
//! 3. Enforce the interrupt policy (demote-not-drop).
//! 4. Post to the board. Honored interrupts are delivered immediately
//!    (wake-limited); deferred cards wait for the digest tick.

use std::collections::BTreeSet;

use serde::Deserialize;

use crate::board::{Board, NewCard};
use crate::card::InterruptPolicy;
use crate::deliver::{deliver_card, CardTransport};
use crate::policy;
use crate::roster::Roster;
use crate::tracker::Tracker;
use crate::wake::{full_jitter, TokenBucket};

/// One normalized inbound unit of work from any source (Matrix message,
/// tracker transition, system condition), as spooled into the ingest dir.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InboundMessage {
    /// Originating identity (Matrix user id or agent handle). The dispatcher
    /// classifies this itself.
    pub sender: String,
    /// Addressed recipient handle; None = open pool work.
    #[serde(default)]
    pub recipient: Option<String>,
    /// Existing tracker task, if this message belongs to one.
    #[serde(default)]
    pub task_id: Option<i64>,
    /// Verbatim content.
    pub body: String,
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub thread: Option<String>,
    #[serde(default)]
    pub requires_reply: bool,
    /// The interrupt class the SENDER requests — enforcement decides.
    #[serde(default)]
    pub interrupt_policy: InterruptPolicy,
    /// Capability tags the work needs.
    #[serde(default)]
    pub needs: BTreeSet<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
    /// Producer-stable idempotency key (e.g. the Matrix event id). When set,
    /// a replay of the same message — crash recovery, redelivery — is a
    /// no-op instead of a duplicate task + card.
    #[serde(default)]
    pub dedupe_key: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum Routed {
    /// Honored interrupt, delivered now. (card_id, envelope_id)
    Interrupted {
        card_id: String,
        envelope_id: String,
    },
    /// Honored interrupt whose delivery failed; the card sits undelivered on
    /// the board and the daemon's redelivery pass retries it.
    InterruptPending { card_id: String },
    /// Queued for the digest / the wanted board.
    Queued { card_id: String, demoted: bool },
    /// The message's dedupe_key was already processed; nothing was written.
    Duplicate { card_id: String },
}

pub struct Dispatcher<'a> {
    pub board: &'a Board,
    pub roster: &'a Roster,
    pub tracker: Option<&'a dyn Tracker>,
    pub transport: &'a dyn CardTransport,
    pub wake_bucket: TokenBucket,
    pub lease_ms: i64,
}

impl<'a> Dispatcher<'a> {
    /// Route one inbound message. `now_ms`/`now_rfc3339` are injected for
    /// testability (and because the board is epoch-ms native).
    pub fn dispatch(
        &mut self,
        msg: &InboundMessage,
        now_ms: i64,
        now_rfc3339: &str,
    ) -> Result<Routed, String> {
        // A recipient handle becomes a spool filename downstream: reject
        // anything non-canonical BEFORE it reaches a path (codex P1 —
        // `../../tmp/evil` must never leave this function).
        if let Some(recipient) = &msg.recipient {
            if !crate::card::is_canonical_handle(recipient) {
                return Err(format!(
                    "non-canonical recipient handle {recipient:?} — refused"
                ));
            }
        }

        let sender_class = self.roster.classify(&msg.sender);

        // Enforce the interrupt model BEFORE any side effect (adversarial-
        // review #3: a refused card must not have filed a task or posted a
        // card). For brand-new work (task_id=None) the honor check uses a
        // sentinel that can never match an active lease — a task that
        // doesn't exist yet can't be the one being clarified.
        let active_lease = match (&msg.recipient, self.tracker) {
            (Some(recipient), Some(t)) => t.active_lease(recipient)?,
            _ => None,
        };
        let enforcement = policy::enforce(
            msg.interrupt_policy,
            sender_class,
            msg.task_id.unwrap_or(-1),
            active_lease,
        );
        if enforcement.demoted {
            crate::glitchtip::capture_message(
                &format!(
                    "interrupt demoted: sender={} requested={:?} class={:?} task={:?}",
                    msg.sender, msg.interrupt_policy, sender_class, msg.task_id
                ),
                "warning",
            );
        }
        let will_interrupt = policy::interrupts(enforcement.effective);
        if will_interrupt {
            // Interrupts are addressed by definition (there is someone to
            // interrupt), and must target a known, active fleet member — an
            // unknown handle would spool into a dead file forever. Checked
            // before file_task/post so refusal has zero side effects.
            let Some(recipient) = &msg.recipient else {
                return Err("interrupt message has no recipient — refused".into());
            };
            if !self.roster.is_active_agent(recipient) {
                return Err(format!(
                    "interrupt targets unknown/inactive agent {recipient:?} — refused"
                ));
            }
        }

        // Idempotent replay: if this producer key was already dispatched,
        // do nothing (checked before file_task so replays don't duplicate
        // tracker tasks either — adversarial-review #2).
        if let Some(key) = &msg.dedupe_key {
            if let Some(card_id) = self.board.dedupe_lookup(key)? {
                return Ok(Routed::Duplicate { card_id });
            }
        }

        // Spawn-from-task: resolve or file the tracker task FIRST.
        let task_id = match msg.task_id {
            Some(id) => id,
            None => match self.tracker {
                Some(t) => {
                    let title: String = msg.body.chars().take(80).collect();
                    t.file_task(&title, &msg.body, msg.priority.unwrap_or(2), &msg.sender)?
                }
                None => {
                    return Err(
                        "no task_id and tracker integration disabled — card refused \
                         (tracker is the source of truth)"
                            .into(),
                    )
                }
            },
        };

        let card_id = match self.board.post_deduped(
            &NewCard {
                task_id,
                sender: msg.sender.clone(),
                sender_class,
                recipient: msg.recipient.clone(),
                priority: msg.priority.unwrap_or(2).min(3),
                thread: msg.thread.clone(),
                requires_reply: msg.requires_reply,
                interrupt_policy: enforcement.effective,
                body: msg.body.clone(),
                needs: msg.needs.clone(),
                reply_to: msg.reply_to.clone(),
                parent_id: None,
            },
            now_ms,
            msg.dedupe_key.as_deref(),
        )? {
            crate::board::PostOutcome::Posted(id) => id,
            // Lost a race with a concurrent dispatch of the same message.
            crate::board::PostOutcome::Duplicate(id) => {
                return Ok(Routed::Duplicate { card_id: id })
            }
        };

        if will_interrupt {
            // Wake rate limit (DP10): a throttled interrupt still goes out —
            // after the advised wait + jitter, not never.
            if let Err(wait) = self.wake_bucket.try_take(now_ms) {
                std::thread::sleep(wait + full_jitter(wait));
            }
            let board_card = self.board.get(&card_id)?.expect("just posted");
            let wire = Board::to_task_card(&board_card, now_rfc3339)
                .expect("interrupt cards are addressed");
            let envelope_id = match deliver_card(
                self.transport,
                &wire,
                || now_rfc3339.to_string(),
                5,
                |attempt| std::time::Duration::from_millis(200 * (1 << attempt.min(4))),
            ) {
                Ok(id) => id,
                Err(e) => {
                    // The card is durable on the board (delivered=0); the
                    // daemon's redelivery pass retries it — never lost (codex P1).
                    crate::glitchtip::capture_message(
                        &format!("interrupt delivery failed, card {card_id} pending: {e}"),
                        "error",
                    );
                    return Ok(Routed::InterruptPending { card_id });
                }
            };
            self.board
                .mark_delivered(std::slice::from_ref(&card_id), now_ms)?;
            Ok(Routed::Interrupted {
                card_id,
                envelope_id,
            })
        } else {
            Ok(Routed::Queued {
                card_id,
                demoted: enforcement.demoted,
            })
        }
    }
}

impl Dispatcher<'_> {
    /// Retry delivery of honored interrupts whose earlier delivery failed
    /// (the cards are durable on the board with delivered=0). Returns how
    /// many were delivered this pass. Recipients that have dropped out of
    /// the roster are skipped (their cards stay visible on the board for
    /// triage rather than silently vanishing).
    pub fn redeliver_pending(&mut self, now_ms: i64, now_rfc3339: &str) -> Result<usize, String> {
        let pending = self.board.undelivered_interrupts()?;
        let mut delivered = 0;
        for card in pending {
            let Some(recipient) = card.recipient.clone() else {
                continue;
            };
            if !self.roster.is_active_agent(&recipient) {
                continue;
            }
            if let Err(wait) = self.wake_bucket.try_take(now_ms) {
                std::thread::sleep(wait + full_jitter(wait));
            }
            let Some(wire) = Board::to_task_card(&card, now_rfc3339) else {
                continue;
            };
            match deliver_card(
                self.transport,
                &wire,
                || now_rfc3339.to_string(),
                3,
                |attempt| std::time::Duration::from_millis(200 * (1 << attempt.min(4))),
            ) {
                Ok(_) => {
                    self.board
                        .mark_delivered(std::slice::from_ref(&card.card_id), now_ms)?;
                    delivered += 1;
                }
                Err(e) => {
                    eprintln!(
                        "dispatcher: redelivery of {} still failing: {e}",
                        card.card_id
                    );
                }
            }
        }
        Ok(delivered)
    }
}

impl std::fmt::Debug for Dispatcher<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dispatcher").finish_non_exhaustive()
    }
}

impl From<crate::board::BoardError> for String {
    fn from(e: crate::board::BoardError) -> String {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::SenderClass;
    use crate::envelope::Envelope;
    use std::sync::Mutex;

    #[derive(Default)]
    struct CapturingTransport {
        delivered: Mutex<Vec<Envelope>>,
    }

    impl CardTransport for CapturingTransport {
        fn deliver(&self, envelope: &Envelope) -> Result<(), String> {
            self.delivered.lock().unwrap().push(envelope.clone());
            Ok(())
        }
    }

    struct FakeTracker {
        active: Option<i64>,
        filed: Mutex<Vec<String>>,
    }

    impl Tracker for FakeTracker {
        fn file_task(&self, title: &str, _: &str, _: u8, _: &str) -> Result<i64, String> {
            self.filed.lock().unwrap().push(title.to_string());
            Ok(900 + self.filed.lock().unwrap().len() as i64)
        }
        fn active_lease(&self, _: &str) -> Result<Option<i64>, String> {
            Ok(self.active)
        }
    }

    fn roster() -> Roster {
        let mut r = Roster::new(
            vec!["@parker:petalnet.example".to_string()],
            vec!["system:watchdog".to_string()],
        );
        r.upsert_agent(crate::roster::AgentEntry {
            handle: "janet".into(),
            capabilities: BTreeSet::new(),
            active: true,
        });
        r
    }

    fn msg(sender: &str, policy: InterruptPolicy) -> InboundMessage {
        InboundMessage {
            sender: sender.into(),
            recipient: Some("janet".into()),
            task_id: Some(670),
            body: "do the thing".into(),
            priority: Some(1),
            thread: None,
            requires_reply: false,
            interrupt_policy: policy,
            needs: BTreeSet::new(),
            reply_to: None,
            dedupe_key: None,
        }
    }

    fn dispatcher<'a>(
        board: &'a Board,
        roster: &'a Roster,
        tracker: &'a FakeTracker,
        transport: &'a CapturingTransport,
    ) -> Dispatcher<'a> {
        Dispatcher {
            board,
            roster,
            tracker: Some(tracker),
            transport,
            wake_bucket: TokenBucket::new(100.0, 100.0, 0),
            lease_ms: 60_000,
        }
    }

    #[test]
    fn principal_command_from_principal_interrupts_and_delivers() {
        let board = Board::open_in_memory().unwrap();
        let r = roster();
        let t = FakeTracker {
            active: None,
            filed: Mutex::new(vec![]),
        };
        let tx = CapturingTransport::default();
        let mut d = dispatcher(&board, &r, &t, &tx);
        let routed = d
            .dispatch(
                &msg(
                    "@parker:petalnet.example",
                    InterruptPolicy::PrincipalCommand,
                ),
                1000,
                "2026-07-12T11:00:00Z",
            )
            .unwrap();
        let Routed::Interrupted {
            card_id,
            envelope_id,
        } = routed
        else {
            panic!("expected interrupt, got {routed:?}");
        };
        let sent = tx.delivered.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].id, envelope_id);
        let card = &sent[0].payload.as_ref().unwrap()["card"];
        assert_eq!(card["card_id"], serde_json::Value::String(card_id.clone()));
        assert_eq!(card["sender_class"], "principal");
        assert_eq!(card["interrupt_policy"], "principal_command");
        // Delivered interrupts don't reappear in the digest.
        assert!(board.deferred_for("janet", 0).unwrap().is_empty());
    }

    #[test]
    fn spoofed_principal_command_is_demoted_and_queued() {
        let board = Board::open_in_memory().unwrap();
        let r = roster();
        let t = FakeTracker {
            active: None,
            filed: Mutex::new(vec![]),
        };
        let tx = CapturingTransport::default();
        let mut d = dispatcher(&board, &r, &t, &tx);
        let routed = d
            .dispatch(
                &msg("@mallory:evil.example", InterruptPolicy::PrincipalCommand),
                1000,
                "2026-07-12T11:00:00Z",
            )
            .unwrap();
        let Routed::Queued { card_id, demoted } = routed else {
            panic!("expected queue, got {routed:?}");
        };
        assert!(demoted);
        assert!(tx.delivered.lock().unwrap().is_empty(), "nothing delivered");
        // The content still flows — demote, never drop (D27).
        let card = board.get(&card_id).unwrap().unwrap();
        assert_eq!(card.interrupt_policy, InterruptPolicy::Defer);
        assert_eq!(card.sender_class, SenderClass::Agent);
        assert_eq!(board.deferred_for("janet", 0).unwrap().len(), 1);
    }

    #[test]
    fn task_clarification_honored_only_on_active_lease() {
        let board = Board::open_in_memory().unwrap();
        let r = roster();
        let tx = CapturingTransport::default();
        // Recipient's active lease IS task 670 → interrupt.
        let t = FakeTracker {
            active: Some(670),
            filed: Mutex::new(vec![]),
        };
        let mut d = dispatcher(&board, &r, &t, &tx);
        let routed = d
            .dispatch(
                &msg("janet2", InterruptPolicy::TaskClarification),
                0,
                "2026-07-12T11:00:00Z",
            )
            .unwrap();
        assert!(matches!(routed, Routed::Interrupted { .. }));
        // Different active task → demoted.
        let t2 = FakeTracker {
            active: Some(7),
            filed: Mutex::new(vec![]),
        };
        let mut d2 = dispatcher(&board, &r, &t2, &tx);
        let routed = d2
            .dispatch(
                &msg("janet2", InterruptPolicy::TaskClarification),
                0,
                "2026-07-12T11:00:00Z",
            )
            .unwrap();
        assert!(matches!(routed, Routed::Queued { demoted: true, .. }));
    }

    #[test]
    fn new_work_files_a_task_first() {
        let board = Board::open_in_memory().unwrap();
        let r = roster();
        let t = FakeTracker {
            active: None,
            filed: Mutex::new(vec![]),
        };
        let tx = CapturingTransport::default();
        let mut d = dispatcher(&board, &r, &t, &tx);
        let mut m = msg("@parker:petalnet.example", InterruptPolicy::Defer);
        m.task_id = None;
        m.body = "please investigate the flaky backup job".into();
        let routed = d.dispatch(&m, 0, "2026-07-12T11:00:00Z").unwrap();
        let Routed::Queued { card_id, .. } = routed else {
            panic!()
        };
        assert_eq!(t.filed.lock().unwrap().len(), 1, "task filed before card");
        let card = board.get(&card_id).unwrap().unwrap();
        assert_eq!(card.task_id, 901);
    }

    #[test]
    fn new_work_without_tracker_is_refused() {
        let board = Board::open_in_memory().unwrap();
        let r = roster();
        let tx = CapturingTransport::default();
        let mut d = Dispatcher {
            board: &board,
            roster: &r,
            tracker: None,
            transport: &tx,
            wake_bucket: TokenBucket::new(100.0, 100.0, 0),
            lease_ms: 60_000,
        };
        let mut m = msg("@parker:petalnet.example", InterruptPolicy::Defer);
        m.task_id = None;
        let err = d.dispatch(&m, 0, "2026-07-12T11:00:00Z").unwrap_err();
        assert!(err.contains("source of truth"), "{err}");
    }

    #[test]
    fn non_canonical_recipient_is_refused_before_any_path() {
        let board = Board::open_in_memory().unwrap();
        let r = roster();
        let t = FakeTracker {
            active: None,
            filed: Mutex::new(vec![]),
        };
        let tx = CapturingTransport::default();
        let mut d = dispatcher(&board, &r, &t, &tx);
        for evil in ["../../tmp/evil", "Janet", "a b", ""] {
            let mut m = msg(
                "@parker:petalnet.example",
                InterruptPolicy::PrincipalCommand,
            );
            m.recipient = Some(evil.into());
            let err = d.dispatch(&m, 0, "2026-07-12T11:00:00Z").unwrap_err();
            assert!(err.contains("non-canonical"), "{evil:?}: {err}");
        }
        assert!(tx.delivered.lock().unwrap().is_empty());
    }

    #[test]
    fn dedupe_replay_is_a_noop_for_task_and_card() {
        let board = Board::open_in_memory().unwrap();
        let r = roster();
        let t = FakeTracker {
            active: None,
            filed: Mutex::new(vec![]),
        };
        let tx = CapturingTransport::default();
        let mut d = dispatcher(&board, &r, &t, &tx);
        let mut m = msg("@parker:petalnet.example", InterruptPolicy::Defer);
        m.task_id = None;
        m.dedupe_key = Some("$evt42".into());
        let first = d.dispatch(&m, 0, "2026-07-12T11:00:00Z").unwrap();
        let Routed::Queued { card_id, .. } = &first else {
            panic!("{first:?}")
        };
        // Crash-recovery replay of the same line.
        let replay = d.dispatch(&m, 100, "2026-07-12T11:00:01Z").unwrap();
        assert_eq!(
            replay,
            Routed::Duplicate {
                card_id: card_id.clone()
            }
        );
        assert_eq!(t.filed.lock().unwrap().len(), 1, "exactly one task filed");
        assert_eq!(
            board.deferred_for("janet", 200).unwrap().len(),
            1,
            "one card"
        );
    }

    #[test]
    fn interrupt_to_unknown_agent_is_refused_with_zero_side_effects() {
        let board = Board::open_in_memory().unwrap();
        let r = roster();
        let t = FakeTracker {
            active: None,
            filed: Mutex::new(vec![]),
        };
        let tx = CapturingTransport::default();
        let mut d = dispatcher(&board, &r, &t, &tx);
        let mut m = msg(
            "@parker:petalnet.example",
            InterruptPolicy::PrincipalCommand,
        );
        m.recipient = Some("ghost-agent".into());
        m.task_id = None; // brand-new work — refusal must not file it
        let err = d.dispatch(&m, 0, "2026-07-12T11:00:00Z").unwrap_err();
        // Adversarial-review #3: refusal happens BEFORE side effects.
        assert!(t.filed.lock().unwrap().is_empty(), "no task filed");
        assert!(
            board.undelivered_interrupts().unwrap().is_empty(),
            "no orphan card"
        );
        assert!(board.distinct_deferred_recipients().unwrap().is_empty());
        assert!(err.contains("unknown/inactive"), "{err}");
    }

    struct FailNTransport {
        failures_left: AtomicU32,
        delivered: Mutex<Vec<Envelope>>,
    }

    use std::sync::atomic::{AtomicU32, Ordering};

    impl CardTransport for FailNTransport {
        fn deliver(&self, envelope: &Envelope) -> Result<(), String> {
            if self.failures_left.load(Ordering::SeqCst) > 0 {
                self.failures_left.fetch_sub(1, Ordering::SeqCst);
                return Err("transport down".into());
            }
            self.delivered.lock().unwrap().push(envelope.clone());
            Ok(())
        }
    }

    #[test]
    fn failed_interrupt_is_durable_and_redelivered() {
        let board = Board::open_in_memory().unwrap();
        let r = roster();
        let t = FakeTracker {
            active: None,
            filed: Mutex::new(vec![]),
        };
        // Fail more times than dispatch's 5 attempts, so the first delivery
        // exhausts and the card goes pending; the transport then recovers.
        let tx = FailNTransport {
            failures_left: AtomicU32::new(5),
            delivered: Mutex::new(vec![]),
        };
        let mut d = Dispatcher {
            board: &board,
            roster: &r,
            tracker: Some(&t),
            transport: &tx,
            wake_bucket: TokenBucket::new(100.0, 100.0, 0),
            lease_ms: 60_000,
        };
        let routed = d
            .dispatch(
                &msg(
                    "@parker:petalnet.example",
                    InterruptPolicy::PrincipalCommand,
                ),
                0,
                "2026-07-12T11:00:00Z",
            )
            .unwrap();
        let Routed::InterruptPending { card_id } = routed else {
            panic!("expected pending, got {routed:?}");
        };
        assert!(tx.delivered.lock().unwrap().is_empty());
        assert_eq!(board.undelivered_interrupts().unwrap().len(), 1);

        // The daemon's redelivery pass picks it up once the transport is back.
        let n = d.redeliver_pending(1000, "2026-07-12T11:01:00Z").unwrap();
        assert_eq!(n, 1);
        let sent = tx.delivered.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].payload.as_ref().unwrap()["card"]["card_id"],
            serde_json::Value::String(card_id)
        );
        assert!(board.undelivered_interrupts().unwrap().is_empty());
    }

    #[test]
    fn safety_interrupt_without_recipient_is_refused() {
        let board = Board::open_in_memory().unwrap();
        let r = roster();
        let t = FakeTracker {
            active: None,
            filed: Mutex::new(vec![]),
        };
        let tx = CapturingTransport::default();
        let mut d = dispatcher(&board, &r, &t, &tx);
        let mut m = msg("system:watchdog", InterruptPolicy::Safety);
        m.recipient = None;
        let err = d.dispatch(&m, 0, "2026-07-12T11:00:00Z").unwrap_err();
        assert!(err.contains("no recipient"), "{err}");
    }
}
