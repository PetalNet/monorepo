//! Tracker-usage discipline enforcement (CP9): the fleet rule "every unit of
//! work is a task, status kept live" made structural instead of relying on
//! agents remembering.
//!
//! Pure checker: given the latest fleet event per agent and its active-lease
//! state, emit violations. The caller turns violations into `defer` nag cards
//! (never interrupts) and escalates repeat offenders to a principal report.

use serde::Serialize;

/// The slice of a fleet event this checker needs (fleet-event contract v1).
#[derive(Debug, Clone)]
pub struct AgentActivity {
    pub handle: String,
    /// Producer-reported status: alive | working | idle.
    pub status: String,
    /// task_id from the event (the explicit spawn-from-task tie), if any.
    pub event_task_id: Option<i64>,
    /// When the agent entered `working` (epoch secs, best known).
    pub working_since_epoch: i64,
    /// The tracker's view: the agent's active lease.
    pub active_lease: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ViolationKind {
    /// Working with no claimed task anywhere (no lease, no event task_id).
    WorkingWithoutTask,
    /// Event claims a task that is NOT the leased one (stale or wrong tie).
    TaskMismatch { event_task: i64, leased_task: i64 },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Violation {
    pub handle: String,
    pub kind: ViolationKind,
}

pub struct Discipline {
    /// Grace before `working` without a task becomes a violation.
    pub grace_secs: i64,
}

impl Default for Discipline {
    fn default() -> Self {
        Discipline { grace_secs: 600 }
    }
}

impl Discipline {
    pub fn check(&self, activity: &AgentActivity, now_epoch: i64) -> Option<Violation> {
        if activity.status != "working" {
            return None;
        }
        let working_for = now_epoch - activity.working_since_epoch;
        match (activity.active_lease, activity.event_task_id) {
            // Lease and event agree (or the event omits task_id — the lease
            // join covers it, v0 fallback): compliant.
            (Some(lease), Some(event)) if lease == event => None,
            (Some(lease), Some(event)) => Some(Violation {
                handle: activity.handle.clone(),
                kind: ViolationKind::TaskMismatch {
                    event_task: event,
                    leased_task: lease,
                },
            }),
            (Some(_), None) => None,
            // No lease at all: violation once past grace, whatever the event says.
            (None, _) if working_for > self.grace_secs => Some(Violation {
                handle: activity.handle.clone(),
                kind: ViolationKind::WorkingWithoutTask,
            }),
            (None, _) => None,
        }
    }
}

/// Render a violation as the nag-card body (verbatim-forwardable).
pub fn nag_body(v: &Violation) -> String {
    match &v.kind {
        ViolationKind::WorkingWithoutTask => format!(
            "tracker discipline: you've been in `working` state past the grace window with \
             no claimed task. Claim the task you're working (or file it) — the tracker is \
             the fleet's source of truth. (agent: {})",
            v.handle
        ),
        ViolationKind::TaskMismatch {
            event_task,
            leased_task,
        } => format!(
            "tracker discipline: your fleet events report task {event_task} but your active \
             lease is task {leased_task}. Update your status or re-claim the right task. \
             (agent: {})",
            v.handle
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn activity(status: &str, lease: Option<i64>, event: Option<i64>, since: i64) -> AgentActivity {
        AgentActivity {
            handle: "box-a".into(),
            status: status.into(),
            event_task_id: event,
            working_since_epoch: since,
            active_lease: lease,
        }
    }

    #[test]
    fn table() {
        let d = Discipline { grace_secs: 600 };
        let now = 10_000;
        // (activity, expect_violation)
        assert_eq!(d.check(&activity("idle", None, None, 0), now), None);
        assert_eq!(d.check(&activity("alive", None, None, 0), now), None);
        // Working with matching lease+event: fine.
        assert_eq!(
            d.check(&activity("working", Some(7), Some(7), 0), now),
            None
        );
        // Working with lease, event omits task_id (v0 hook): fine.
        assert_eq!(d.check(&activity("working", Some(7), None, 0), now), None);
        // Mismatch is flagged immediately (no grace — it's a wrong tie, not a slow claim).
        let v = d
            .check(&activity("working", Some(7), Some(9), now - 1), now)
            .unwrap();
        assert_eq!(
            v.kind,
            ViolationKind::TaskMismatch {
                event_task: 9,
                leased_task: 7
            }
        );
        // No lease: grace window applies.
        assert_eq!(
            d.check(&activity("working", None, None, now - 599), now),
            None
        );
        let v = d
            .check(&activity("working", None, None, now - 601), now)
            .unwrap();
        assert_eq!(v.kind, ViolationKind::WorkingWithoutTask);
        // Event task_id without a lease is still a violation past grace
        // (a task_id you haven't claimed isn't a lease).
        let v = d
            .check(&activity("working", None, Some(9), now - 601), now)
            .unwrap();
        assert_eq!(v.kind, ViolationKind::WorkingWithoutTask);
    }

    #[test]
    fn nag_bodies_name_the_problem() {
        let v = Violation {
            handle: "box-a".into(),
            kind: ViolationKind::WorkingWithoutTask,
        };
        assert!(nag_body(&v).contains("no claimed task"));
        let v = Violation {
            handle: "box-a".into(),
            kind: ViolationKind::TaskMismatch {
                event_task: 9,
                leased_task: 7,
            },
        };
        let body = nag_body(&v);
        assert!(body.contains("task 9") && body.contains("task 7"));
    }
}
