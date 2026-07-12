//! Card delivery — the transport boundary (DP9).
//!
//! `CardTransport` is the seam the doorman backchannel plugs into (N1.4):
//! today's implementations are the JSONL spool (the proven drain-hook
//! pattern, consumable by disposable test agents) and an in-proc transport
//! for tests. Deliveries are wrapped in the backchannel-rpc envelope; a retry
//! re-sends the SAME envelope id so receivers can de-duplicate (contract
//! D20).

use std::io::Write;
use std::path::PathBuf;

use crate::card::TaskCard;
use crate::envelope::Envelope;

pub trait CardTransport: Send {
    /// Deliver one envelope to its agent. Err = retryable transport failure
    /// (the caller re-sends the SAME envelope after backoff).
    fn deliver(&self, envelope: &Envelope) -> Result<(), String>;
}

/// Per-recipient JSONL outbox: `<dir>/<handle>.outbox.jsonl`, one envelope per
/// line, appended atomically (O_APPEND single write ≤ PIPE_BUF-ish sizes; the
/// consumer tolerates a torn last line by ignoring unparsable tails).
pub struct SpoolTransport {
    dir: PathBuf,
}

impl SpoolTransport {
    pub fn new(dir: PathBuf) -> SpoolTransport {
        SpoolTransport { dir }
    }
}

impl CardTransport for SpoolTransport {
    fn deliver(&self, envelope: &Envelope) -> Result<(), String> {
        // Defense in depth: the agent handle becomes a filename. The dispatch
        // boundary already rejects non-canonical recipients; enforce it here
        // too so no other caller can traverse out of the spool dir.
        if !crate::card::is_canonical_handle(&envelope.agent) {
            return Err(format!(
                "refusing spool delivery to non-canonical handle {:?}",
                envelope.agent
            ));
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let path = self.dir.join(format!("{}.outbox.jsonl", envelope.agent));
        let mut line = serde_json::to_string(envelope).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        f.write_all(line.as_bytes()).map_err(|e| e.to_string())
    }
}

/// Deliver a card: build the task.dispatch envelope ONCE, then attempt with
/// bounded retries; every attempt reuses the same envelope (idempotency on
/// id). Returns the envelope id on success.
pub fn deliver_card(
    transport: &dyn CardTransport,
    card: &TaskCard,
    now_rfc3339: impl Fn() -> String,
    max_attempts: u32,
    backoff: impl Fn(u32) -> std::time::Duration,
) -> Result<String, String> {
    let card_json = serde_json::to_value(card).map_err(|e| e.to_string())?;
    let envelope = Envelope::task_dispatch(&card.recipient, card.task_id, card_json, now_rfc3339());
    envelope.validate()?;
    let mut last_err = String::new();
    for attempt in 0..max_attempts {
        match transport.deliver(&envelope) {
            Ok(()) => return Ok(envelope.id),
            Err(e) => {
                last_err = e;
                if attempt + 1 < max_attempts {
                    std::thread::sleep(crate::wake::full_jitter(backoff(attempt)));
                }
            }
        }
    }
    Err(format!(
        "delivery failed after {max_attempts} attempts: {last_err}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::{InterruptPolicy, SenderClass};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    fn card() -> TaskCard {
        TaskCard {
            schema_version: 1,
            card_id: "c-1".into(),
            task_id: 7,
            sender: "@parker:petalnet.example".into(),
            sender_class: SenderClass::Principal,
            recipient: "janet".into(),
            priority: 1,
            thread: None,
            requires_reply: false,
            interrupt_policy: InterruptPolicy::Defer,
            body: "hello".into(),
            capability: None,
            lease: None,
            created_at: "2026-07-12T11:00:00Z".into(),
            expires_at: None,
        }
    }

    struct FlakyTransport {
        fail_first: u32,
        calls: AtomicU32,
        seen_ids: Mutex<Vec<String>>,
    }

    impl CardTransport for FlakyTransport {
        fn deliver(&self, envelope: &Envelope) -> Result<(), String> {
            self.seen_ids.lock().unwrap().push(envelope.id.clone());
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n < self.fail_first {
                Err("transient".into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn retries_reuse_the_same_envelope_id() {
        let t = FlakyTransport {
            fail_first: 2,
            calls: AtomicU32::new(0),
            seen_ids: Mutex::new(vec![]),
        };
        let id = deliver_card(
            &t,
            &card(),
            || "2026-07-12T11:00:00Z".into(),
            5,
            |_| std::time::Duration::ZERO,
        )
        .unwrap();
        let seen = t.seen_ids.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert!(
            seen.iter().all(|s| *s == id),
            "idempotency key must not change"
        );
    }

    #[test]
    fn gives_up_after_max_attempts() {
        let t = FlakyTransport {
            fail_first: u32::MAX,
            calls: AtomicU32::new(0),
            seen_ids: Mutex::new(vec![]),
        };
        let err = deliver_card(
            &t,
            &card(),
            || "2026-07-12T11:00:00Z".into(),
            3,
            |_| std::time::Duration::ZERO,
        )
        .unwrap_err();
        assert!(err.contains("after 3 attempts"), "{err}");
        assert_eq!(t.calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn spool_refuses_non_canonical_handles() {
        let dir = tempfile::tempdir().unwrap();
        let t = SpoolTransport::new(dir.path().to_path_buf());
        let mut c = card();
        c.recipient = "../../etc/passwd".into();
        let card_json = serde_json::to_value(&c).unwrap();
        let env = Envelope::task_dispatch(
            &c.recipient,
            c.task_id,
            card_json,
            "2026-07-12T11:00:00Z".into(),
        );
        let err = t.deliver(&env).unwrap_err();
        assert!(err.contains("non-canonical"), "{err}");
        // Nothing escaped the spool dir (the dir itself stays empty).
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn spool_appends_one_envelope_per_line() {
        let dir = tempfile::tempdir().unwrap();
        let t = SpoolTransport::new(dir.path().to_path_buf());
        for _ in 0..3 {
            deliver_card(
                &t,
                &card(),
                || "2026-07-12T11:00:00Z".into(),
                1,
                |_| std::time::Duration::ZERO,
            )
            .unwrap();
        }
        let content = std::fs::read_to_string(dir.path().join("janet.outbox.jsonl")).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3);
        for line in lines {
            let e: Envelope = serde_json::from_str(line).unwrap();
            assert_eq!(e.agent, "janet");
            assert_eq!(e.method.as_deref(), Some("task.dispatch"));
            assert!(e.validate().is_ok());
        }
    }
}
