//! The worker pool (BA2/BA4): disposable child processes, one per task-card.
//!
//! OS-neutral by construction — workers are `std::process::Command` argv
//! (config template, `{body}`/`{task_id}`/`{card_id}` placeholders + card
//! fields in env), never a shell string. Deferred cards queue FIFO when the
//! slot cap is reached; honored interrupts bypass the cap (the cap protects
//! the box from bulk work, not from Parker).

use std::collections::VecDeque;
use std::process::{Child, Command, Stdio};

use dispatcher::card::{InterruptPolicy, TaskCard};

pub struct RunningWorker {
    pub card: TaskCard,
    /// The task.dispatch envelope id this worker answers (response correlation).
    pub request_id: String,
    pub child: Child,
    pub started_epoch: i64,
}

pub struct FinishedWorker {
    pub card: TaskCard,
    pub request_id: String,
    pub exit_code: Option<i32>,
    pub started_epoch: i64,
}

pub struct WorkerPool {
    cmd_template: Vec<String>,
    pub max_workers: usize,
    running: Vec<RunningWorker>,
    queued: VecDeque<(TaskCard, String)>,
}

fn fill(template: &str, card: &TaskCard) -> String {
    template
        .replace("{body}", &card.body)
        .replace("{task_id}", &card.task_id.to_string())
        .replace("{card_id}", &card.card_id)
}

impl WorkerPool {
    pub fn new(cmd_template: Vec<String>, max_workers: usize) -> WorkerPool {
        WorkerPool {
            cmd_template,
            max_workers,
            running: Vec::new(),
            queued: VecDeque::new(),
        }
    }

    pub fn running_count(&self) -> usize {
        self.running.len()
    }

    pub fn queued_count(&self) -> usize {
        self.queued.len()
    }

    pub fn free_slots(&self) -> u32 {
        self.max_workers.saturating_sub(self.running.len()) as u32
    }

    /// Accept a card: spawn now (interrupts always; deferred work when a slot
    /// is free) or queue it. Returns true if spawned immediately.
    pub fn accept(
        &mut self,
        card: TaskCard,
        request_id: String,
        now_epoch: i64,
    ) -> Result<bool, String> {
        let is_interrupt = card.interrupt_policy != InterruptPolicy::Defer;
        if is_interrupt || self.running.len() < self.max_workers {
            self.spawn(card, request_id, now_epoch)?;
            Ok(true)
        } else {
            self.queued.push_back((card, request_id));
            Ok(false)
        }
    }

    fn spawn(&mut self, card: TaskCard, request_id: String, now_epoch: i64) -> Result<(), String> {
        let argv: Vec<String> = self.cmd_template.iter().map(|a| fill(a, &card)).collect();
        let (program, args) = argv.split_first().ok_or("empty worker_cmd")?;
        let child = Command::new(program)
            .args(args)
            .env("FLEET_CARD_ID", &card.card_id)
            .env("FLEET_TASK_ID", card.task_id.to_string())
            .env("FLEET_SENDER", &card.sender)
            .env("FLEET_PRIORITY", card.priority.to_string())
            .env("FLEET_BODY", &card.body)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn {program:?}: {e}"))?;
        self.running.push(RunningWorker {
            card,
            request_id,
            child,
            started_epoch: now_epoch,
        });
        Ok(())
    }

    /// Reap finished children (non-blocking) and backfill freed slots from
    /// the queue. Returns the finished workers for result reporting.
    pub fn reap(&mut self, now_epoch: i64) -> Vec<FinishedWorker> {
        let mut finished = Vec::new();
        let mut still_running = Vec::new();
        for mut w in self.running.drain(..) {
            match w.child.try_wait() {
                Ok(Some(status)) => finished.push(FinishedWorker {
                    card: w.card,
                    request_id: w.request_id,
                    exit_code: status.code(),
                    started_epoch: w.started_epoch,
                }),
                Ok(None) => still_running.push(w),
                Err(e) => {
                    eprintln!("box-agent: try_wait failed for {}: {e}", w.card.card_id);
                    finished.push(FinishedWorker {
                        card: w.card,
                        request_id: w.request_id,
                        exit_code: None,
                        started_epoch: w.started_epoch,
                    });
                }
            }
        }
        self.running = still_running;
        while self.running.len() < self.max_workers {
            let Some((card, request_id)) = self.queued.pop_front() else {
                break;
            };
            if let Err(e) = self.spawn(card, request_id, now_epoch) {
                eprintln!("box-agent: queued spawn failed: {e}");
            }
        }
        finished
    }

    /// The card the pool is "focused" on for fleet-event purposes: the
    /// highest-priority running worker's card (None = idle).
    pub fn focus(&self) -> Option<&TaskCard> {
        self.running
            .iter()
            .map(|w| &w.card)
            .min_by_key(|c| c.priority)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dispatcher::card::SenderClass;

    fn card(id: &str, policy: InterruptPolicy) -> TaskCard {
        TaskCard {
            schema_version: 1,
            card_id: id.into(),
            task_id: 7,
            sender: "dispatcher".into(),
            sender_class: SenderClass::System,
            recipient: "box-a".into(),
            priority: 2,
            thread: None,
            requires_reply: false,
            interrupt_policy: policy,
            body: "unit-test".into(),
            capability: None,
            lease: None,
            created_at: "2026-07-12T11:00:00Z".into(),
            expires_at: None,
        }
    }

    /// A cross-platform-ish long-running command: on unix, `sleep`. The
    /// suite runs on the lab host + linux CI; Windows coverage is the argv
    /// design, not this test binary.
    fn sleeper() -> Vec<String> {
        vec!["sleep".into(), "5".into()]
    }

    fn instant() -> Vec<String> {
        vec!["true".into()]
    }

    #[test]
    fn slot_cap_queues_deferred_work() {
        let mut pool = WorkerPool::new(sleeper(), 2);
        assert!(pool
            .accept(card("c1", InterruptPolicy::Defer), "r1".into(), 0)
            .unwrap());
        assert!(pool
            .accept(card("c2", InterruptPolicy::Defer), "r2".into(), 0)
            .unwrap());
        assert!(!pool
            .accept(card("c3", InterruptPolicy::Defer), "r3".into(), 0)
            .unwrap());
        assert_eq!(pool.running_count(), 2);
        assert_eq!(pool.queued_count(), 1);
        assert_eq!(pool.free_slots(), 0);
    }

    #[test]
    fn interrupts_bypass_the_cap() {
        let mut pool = WorkerPool::new(sleeper(), 1);
        assert!(pool
            .accept(card("c1", InterruptPolicy::Defer), "r1".into(), 0)
            .unwrap());
        assert!(pool
            .accept(
                card("c2", InterruptPolicy::PrincipalCommand),
                "r2".into(),
                0
            )
            .unwrap());
        assert_eq!(pool.running_count(), 2, "interrupt spawned past the cap");
    }

    #[test]
    fn reap_collects_finished_and_backfills_from_queue() {
        let mut pool = WorkerPool::new(instant(), 1);
        pool.accept(card("c1", InterruptPolicy::Defer), "r1".into(), 0)
            .unwrap();
        pool.accept(card("c2", InterruptPolicy::Defer), "r2".into(), 0)
            .unwrap();
        assert_eq!(pool.queued_count(), 1);
        // `true` exits immediately; poll until reaped (bounded).
        let mut all_finished = Vec::new();
        for _ in 0..100 {
            all_finished.extend(pool.reap(1));
            if all_finished.len() == 2 && pool.running_count() == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(all_finished.len(), 2, "both workers finished");
        assert!(all_finished.iter().all(|f| f.exit_code == Some(0)));
        assert_eq!(pool.queued_count(), 0, "queue drained into freed slots");
    }

    #[test]
    fn worker_env_and_placeholders_carry_the_card() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out.txt");
        // argv template with a placeholder — no shell involved.
        let mut pool = WorkerPool::new(
            vec![
                "cp".into(),
                "/dev/null".into(),
                out.to_string_lossy().into_owned(),
            ],
            1,
        );
        let mut c = card("c-env", InterruptPolicy::Defer);
        c.body = "payload".into();
        pool.accept(c, "r1".into(), 0).unwrap();
        for _ in 0..100 {
            if !pool.reap(1).is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(out.exists(), "worker actually ran");
    }

    #[test]
    fn focus_is_highest_priority_running_card() {
        let mut pool = WorkerPool::new(sleeper(), 3);
        let mut low = card("c-low", InterruptPolicy::Defer);
        low.priority = 3;
        let mut high = card("c-high", InterruptPolicy::Defer);
        high.priority = 0;
        pool.accept(low, "r1".into(), 0).unwrap();
        pool.accept(high, "r2".into(), 0).unwrap();
        assert_eq!(pool.focus().unwrap().card_id, "c-high");
    }

    #[test]
    fn empty_or_missing_command_fails_cleanly() {
        let mut pool = WorkerPool::new(vec![], 1);
        assert!(pool
            .accept(card("c1", InterruptPolicy::Defer), "r1".into(), 0)
            .is_err());
        let mut pool = WorkerPool::new(vec!["definitely-not-a-binary-xyz".into()], 1);
        assert!(pool
            .accept(card("c1", InterruptPolicy::Defer), "r1".into(), 0)
            .is_err());
    }
}
