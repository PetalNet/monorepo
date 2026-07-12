//! The worker pool (BA2/BA4): disposable child processes, one per task-card.
//!
//! OS-neutral by construction — workers are `std::process::Command` argv
//! (config template, `{body}`/`{task_id}`/`{card_id}` placeholders in flag
//! *values* + card fields in env), never a shell string. argv[0] (the program)
//! is never substituted, so a card can't choose the binary.
//!
//! The pool tracks only RUNNING workers; the QUEUE of not-yet-started work
//! lives in the durable `pending` table (see [`crate::inbox`]), so a restart
//! never loses queued cards. Honored interrupts bypass the soft slot cap but
//! not an absolute ceiling — the box can never be fork-bombed by a flood of
//! interrupt cards (adversarial-review #3). Each worker has a deadline; a hung
//! child is killed and reaped, never starving a slot forever (#6).

use std::io::Read;
use std::process::{Child, Command, Stdio};

use dispatcher::card::{InterruptPolicy, TaskCard};

/// How much of a worker's combined stdout+stderr we keep for the response tail.
const OUTPUT_TAIL_BYTES: usize = 4096;

pub struct RunningWorker {
    pub card: TaskCard,
    /// The task.dispatch envelope id this worker answers (response correlation).
    pub request_id: String,
    child: Child,
    output: std::fs::File,
    pub started_epoch: i64,
    deadline_epoch: i64,
    killed_for_timeout: bool,
}

pub struct FinishedWorker {
    pub card: TaskCard,
    pub request_id: String,
    pub exit_code: Option<i32>,
    pub started_epoch: i64,
    pub timed_out: bool,
    /// Tail of combined stdout+stderr (BA6).
    pub output_tail: String,
}

pub struct WorkerPool {
    cmd_template: Vec<String>,
    pub max_workers: usize,
    /// Absolute ceiling on concurrent workers (interrupts included) — the
    /// fork-bomb guard. Defaults to a generous multiple of max_workers.
    pub hard_ceiling: usize,
    /// Per-worker wall-clock budget (seconds); a card's own `expires_at` can
    /// only shorten it.
    pub worker_deadline_secs: i64,
    running: Vec<RunningWorker>,
}

/// Substitute placeholders in a NON-program argv element. Single pass over a
/// fixed token set so tokens appearing inside the (verbatim) body are not
/// themselves rewritten (adversarial-review #9).
fn fill(template: &str, card: &TaskCard) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(pos) = rest.find('{') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        if let Some(end) = tail.find('}') {
            let token = &tail[..=end];
            match token {
                "{body}" => out.push_str(&card.body),
                "{task_id}" => out.push_str(&card.task_id.to_string()),
                "{card_id}" => out.push_str(&card.card_id),
                other => out.push_str(other), // unknown token: leave literal
            }
            rest = &tail[end + 1..];
        } else {
            out.push_str(tail);
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

impl WorkerPool {
    /// `max_workers` must be >= 1 (config enforces it).
    pub fn new(cmd_template: Vec<String>, max_workers: usize) -> WorkerPool {
        let max_workers = max_workers.max(1);
        WorkerPool {
            cmd_template,
            max_workers,
            hard_ceiling: max_workers * 4 + 4,
            worker_deadline_secs: 3600,
            running: Vec::new(),
        }
    }

    pub fn running_count(&self) -> usize {
        self.running.len()
    }

    pub fn free_slots(&self) -> u32 {
        self.max_workers.saturating_sub(self.running.len()) as u32
    }

    /// Is there room to start a card right now? A deferred card needs a free
    /// soft slot; an interrupt bypasses that but NOT the hard ceiling.
    pub fn has_room_for(&self, card: &TaskCard) -> bool {
        if self.running.len() >= self.hard_ceiling {
            return false;
        }
        card.interrupt_policy != InterruptPolicy::Defer || self.running.len() < self.max_workers
    }

    /// Start a worker for `card`. Only call when [`has_room_for`](Self::has_room_for)
    /// is true. On spawn failure the card stays in the pending table for retry.
    pub fn spawn(
        &mut self,
        card: TaskCard,
        request_id: String,
        now_epoch: i64,
    ) -> Result<(), String> {
        // Substitute placeholders in argument VALUES only, never argv[0]
        // (adversarial-review #10: a card must not pick the program).
        let mut argv = self.cmd_template.clone();
        for a in argv.iter_mut().skip(1) {
            *a = fill(a, &card);
        }
        let (program, args) = argv.split_first().ok_or("empty worker_cmd")?;

        // Capture combined stdout+stderr into a temp file (bounded tail read on
        // completion) — no pipe-buffer deadlock, and BA6's output tail is real.
        let output = tempfile::tempfile().map_err(|e| format!("worker tmpfile: {e}"))?;
        let out_clone = output.try_clone().map_err(|e| e.to_string())?;
        let err_clone = output.try_clone().map_err(|e| e.to_string())?;
        let child = Command::new(program)
            .args(args)
            .env("FLEET_CARD_ID", &card.card_id)
            .env("FLEET_TASK_ID", card.task_id.to_string())
            .env("FLEET_SENDER", &card.sender)
            .env("FLEET_PRIORITY", card.priority.to_string())
            .env("FLEET_BODY", &card.body)
            .stdin(Stdio::null())
            .stdout(Stdio::from(out_clone))
            .stderr(Stdio::from(err_clone))
            .spawn()
            .map_err(|e| format!("spawn {program:?}: {e}"))?;

        // Deadline: the smaller of the pool budget and the card's own TTL.
        let mut deadline = now_epoch + self.worker_deadline_secs;
        if let Some(exp) = card.expires_at.as_deref() {
            if let Ok(t) = chrono::DateTime::parse_from_rfc3339(exp) {
                deadline = deadline.min(t.timestamp());
            }
        }
        self.running.push(RunningWorker {
            card,
            request_id,
            child,
            output,
            started_epoch: now_epoch,
            deadline_epoch: deadline,
            killed_for_timeout: false,
        });
        Ok(())
    }

    pub fn is_running(&self, card_id: &str) -> bool {
        self.running.iter().any(|w| w.card.card_id == card_id)
    }

    /// Reap finished children (non-blocking) and kill any past their deadline.
    /// A transient `try_wait` error keeps the worker running (it is NOT dropped
    /// unreaped — no zombie, no bogus "finished"; adversarial-review #12).
    pub fn reap(&mut self, now_epoch: i64) -> Vec<FinishedWorker> {
        let mut finished = Vec::new();
        let mut still_running = Vec::new();
        for mut w in self.running.drain(..) {
            // Enforce the deadline before polling.
            if !w.killed_for_timeout && now_epoch >= w.deadline_epoch {
                let _ = w.child.kill();
                w.killed_for_timeout = true;
            }
            match w.child.try_wait() {
                Ok(Some(status)) => {
                    let tail = read_output_tail(&mut w.output);
                    finished.push(FinishedWorker {
                        card: w.card,
                        request_id: w.request_id,
                        exit_code: status.code(),
                        started_epoch: w.started_epoch,
                        timed_out: w.killed_for_timeout,
                        output_tail: tail,
                    });
                }
                Ok(None) => still_running.push(w),
                Err(e) => {
                    // Do NOT declare it finished — keep it to retry next tick so
                    // the child is eventually reaped, not orphaned.
                    eprintln!(
                        "box-agent: try_wait error for {} (retrying): {e}",
                        w.card.card_id
                    );
                    still_running.push(w);
                }
            }
        }
        self.running = still_running;
        finished
    }

    /// Kill and reap every worker (graceful shutdown).
    pub fn shutdown(&mut self) {
        for w in &mut self.running {
            let _ = w.child.kill();
            let _ = w.child.wait();
        }
        self.running.clear();
    }

    /// The card the pool is "focused" on for fleet-event purposes.
    pub fn focus(&self) -> Option<&TaskCard> {
        self.running
            .iter()
            .map(|w| &w.card)
            .min_by_key(|c| c.priority)
    }
}

fn read_output_tail(file: &mut std::fs::File) -> String {
    use std::io::{Seek, SeekFrom};
    let len = file.seek(SeekFrom::End(0)).unwrap_or(0);
    let start = len.saturating_sub(OUTPUT_TAIL_BYTES as u64);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = file.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
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

    fn sleeper() -> Vec<String> {
        vec!["sleep".into(), "30".into()]
    }

    #[test]
    fn fill_is_single_pass_and_preserves_verbatim_body() {
        let mut c = card("c-tpl", InterruptPolicy::Defer);
        c.body = "please summarize {task_id} and {card_id}".into();
        // {body} expands to the verbatim body; tokens INSIDE the body are NOT
        // re-substituted (adversarial-review #9).
        assert_eq!(
            fill("{body}", &c),
            "please summarize {task_id} and {card_id}"
        );
        assert_eq!(fill("--task={task_id}", &c), "--task=7");
        assert_eq!(fill("--id={card_id}", &c), "--id=c-tpl");
        assert_eq!(fill("literal", &c), "literal");
    }

    #[test]
    fn argv0_is_never_substituted() {
        let mut pool = WorkerPool::new(vec!["{body}".into()], 1);
        let mut c = card("c1", InterruptPolicy::Defer);
        c.body = "sh".into();
        // argv[0] stays literal "{body}", which is not a real binary → spawn Err.
        assert!(pool.spawn(c, "r1".into(), 0).is_err());
    }

    #[test]
    fn slot_cap_bounds_deferred_but_interrupts_bypass_up_to_hard_ceiling() {
        let mut pool = WorkerPool::new(sleeper(), 1);
        pool.hard_ceiling = 3;
        assert!(pool.has_room_for(&card("c1", InterruptPolicy::Defer)));
        pool.spawn(card("c1", InterruptPolicy::Defer), "r1".into(), 0)
            .unwrap();
        // Deferred: no soft slot. Interrupt: allowed until the hard ceiling.
        assert!(!pool.has_room_for(&card("c2", InterruptPolicy::Defer)));
        assert!(pool.has_room_for(&card("c2", InterruptPolicy::PrincipalCommand)));
        pool.spawn(
            card("c2", InterruptPolicy::PrincipalCommand),
            "r2".into(),
            0,
        )
        .unwrap();
        pool.spawn(
            card("c3", InterruptPolicy::PrincipalCommand),
            "r3".into(),
            0,
        )
        .unwrap();
        // Hard ceiling reached: even an interrupt is refused (no fork-bomb).
        assert!(!pool.has_room_for(&card("c4", InterruptPolicy::PrincipalCommand)));
        pool.shutdown();
    }

    #[test]
    fn deadline_kills_a_hung_worker() {
        let mut pool = WorkerPool::new(sleeper(), 1);
        pool.worker_deadline_secs = 1;
        pool.spawn(card("c1", InterruptPolicy::Defer), "r1".into(), 1000)
            .unwrap();
        assert!(pool.reap(1000).is_empty(), "not yet past deadline");
        // Simulate time past the deadline; the child is killed and reaped.
        let mut finished = Vec::new();
        for _ in 0..100 {
            finished.extend(pool.reap(2000));
            if !finished.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(finished.len(), 1);
        assert!(finished[0].timed_out, "reported as timed out");
    }

    #[test]
    fn captures_worker_output_tail() {
        let mut pool = WorkerPool::new(
            vec!["sh".into(), "-c".into(), "echo hello-from-worker".into()],
            1,
        );
        pool.spawn(card("c1", InterruptPolicy::Defer), "r1".into(), 0)
            .unwrap();
        let mut finished = Vec::new();
        for _ in 0..100 {
            finished.extend(pool.reap(0));
            if !finished.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(finished.len(), 1);
        assert_eq!(finished[0].exit_code, Some(0));
        assert!(
            finished[0].output_tail.contains("hello-from-worker"),
            "{:?}",
            finished[0].output_tail
        );
    }

    #[test]
    fn env_carries_card_fields() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("env.txt");
        let mut pool = WorkerPool::new(
            vec![
                "sh".into(),
                "-c".into(),
                format!(
                    "printf '%s|%s' \"$FLEET_CARD_ID\" \"$FLEET_TASK_ID\" > {}",
                    out.display()
                ),
            ],
            1,
        );
        pool.spawn(card("c-env", InterruptPolicy::Defer), "r1".into(), 0)
            .unwrap();
        for _ in 0..100 {
            if !pool.reap(0).is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "c-env|7");
    }

    #[test]
    fn spawn_failure_is_recoverable_not_lost() {
        let mut pool = WorkerPool::new(vec!["definitely-not-a-binary-xyz".into()], 1);
        assert!(pool
            .spawn(card("c1", InterruptPolicy::Defer), "r1".into(), 0)
            .is_err());
        assert_eq!(pool.running_count(), 0);
    }

    #[test]
    fn focus_is_highest_priority_running_card() {
        let mut pool = WorkerPool::new(sleeper(), 3);
        let mut low = card("c-low", InterruptPolicy::Defer);
        low.priority = 3;
        let mut high = card("c-high", InterruptPolicy::Defer);
        high.priority = 0;
        pool.spawn(low, "r1".into(), 0).unwrap();
        pool.spawn(high, "r2".into(), 0).unwrap();
        assert_eq!(pool.focus().unwrap().card_id, "c-high");
        pool.shutdown();
    }
}
