//! Interrupt-policy enforcement — the dispatcher's half of the LOCKED
//! interrupt model (contracts D17/D27).
//!
//! Only three things interrupt an agent mid-task; everything else queues into
//! the compact inbox digest. Enforcement happens HERE, before delivery, so
//! the recipient may trust a delivered interrupt:
//!
//! | requested            | honored when                                   |
//! |----------------------|------------------------------------------------|
//! | defer (default)      | always (never interrupts)                      |
//! | principal_command    | sender_class == principal                      |
//! | safety               | always                                         |
//! | task_clarification   | card.task_id == recipient's active lease       |
//!
//! A card claiming a privilege it doesn't qualify for is DEMOTED to `defer`
//! and still delivered (D27): enforcement removes the interrupt privilege,
//! not the content.

use crate::card::{InterruptPolicy, SenderClass};

/// Outcome of enforcement, kept explicit so the caller can log/alert on
/// demotions (a repeated principal_command spoof is a security signal even
/// though the card still flows).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Enforcement {
    pub effective: InterruptPolicy,
    pub demoted: bool,
}

/// `active_lease_task` = the tracker task currently leased by the RECIPIENT
/// (None when it holds no lease).
pub fn enforce(
    requested: InterruptPolicy,
    sender_class: SenderClass,
    card_task_id: i64,
    active_lease_task: Option<i64>,
) -> Enforcement {
    let honored = match requested {
        InterruptPolicy::Defer => true,
        InterruptPolicy::Safety => true,
        InterruptPolicy::PrincipalCommand => sender_class == SenderClass::Principal,
        InterruptPolicy::TaskClarification => active_lease_task == Some(card_task_id),
    };
    if honored {
        Enforcement {
            effective: requested,
            demoted: false,
        }
    } else {
        Enforcement {
            effective: InterruptPolicy::Defer,
            demoted: true,
        }
    }
}

/// Does the effective policy interrupt the recipient right now (vs queue for
/// the digest)?
pub fn interrupts(effective: InterruptPolicy) -> bool {
    !matches!(effective, InterruptPolicy::Defer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use InterruptPolicy::*;
    use SenderClass::*;

    #[test]
    fn table_driven_enforcement() {
        // (requested, sender_class, card_task, active_lease, expect_effective, expect_demoted)
        let cases = [
            (Defer, Principal, 1, None, Defer, false),
            (Defer, Agent, 1, Some(1), Defer, false),
            (Safety, Agent, 1, None, Safety, false),
            (Safety, System, 9, Some(2), Safety, false),
            (
                PrincipalCommand,
                Principal,
                1,
                None,
                PrincipalCommand,
                false,
            ),
            // The spoof: a non-principal claiming principal_command is demoted, not dropped.
            (PrincipalCommand, Agent, 1, None, Defer, true),
            (PrincipalCommand, System, 1, None, Defer, true),
            (
                TaskClarification,
                Agent,
                42,
                Some(42),
                TaskClarification,
                false,
            ),
            // Clarification on a NON-active task queues.
            (TaskClarification, Agent, 42, Some(7), Defer, true),
            (TaskClarification, Principal, 42, None, Defer, true),
        ];
        for (req, class, card_task, lease, want, want_demoted) in cases {
            let got = enforce(req, class, card_task, lease);
            assert_eq!(
                got.effective, want,
                "case {req:?} {class:?} {card_task} {lease:?}"
            );
            assert_eq!(got.demoted, want_demoted, "case {req:?} {class:?}");
        }
    }

    #[test]
    fn only_defer_queues() {
        assert!(!interrupts(Defer));
        assert!(interrupts(Safety));
        assert!(interrupts(PrincipalCommand));
        assert!(interrupts(TaskClarification));
    }
}
