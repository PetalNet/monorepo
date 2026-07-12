//! Task-card contract types — serde mirror of
//! `apps/manager/docs/contracts/schemas/task-card.schema.json` (v1).
//!
//! The card is the ONLY way work reaches an agent. `sender_class` is stamped
//! by the dispatcher from its own roster (never trusted from the sender), and
//! `interrupt_policy` carries the LOCKED three-class interrupt model. The
//! schema is `additionalProperties: false`, so these types deny unknown
//! fields: drift fails loudly at the boundary instead of being skipped.

use serde::{Deserialize, Serialize};

pub const TASK_CARD_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SenderClass {
    /// Parker / Eli — from the dispatcher's principal roster.
    Principal,
    /// A fleet member (any registered agent handle).
    Agent,
    /// Dispatcher / watchdog / monitor origin.
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum InterruptPolicy {
    /// Queue for the inbox digest; never interrupts. The default for everything.
    #[default]
    Defer,
    /// Direct Parker/Eli command — honored only when sender_class=principal.
    PrincipalCommand,
    /// A safety condition — always honored.
    Safety,
    /// Clarification on the recipient's ACTIVE task — honored only when
    /// task_id matches its current lease.
    TaskClarification,
}

/// Viewer-safe lease projection (`queue-lease.schema.json#/$defs/leasePublic`).
/// Never carries `claim_token` — that travels only in the direct claim
/// response to the worker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeasePublic {
    pub schema_version: u32,
    pub task_id: i64,
    pub worker: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fence: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granted_at: Option<String>,
    pub lease_expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_seconds: Option<i64>,
}

/// The card the dispatcher delivers to an agent (task-card.schema.json v1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskCard {
    pub schema_version: u32,
    /// Unique card id; consumers de-duplicate on it (delivery may be retried).
    pub card_id: String,
    /// Tracker task this card belongs to. REQUIRED: the tracker is the source
    /// of truth — a card about brand-new work is created AFTER the dispatcher
    /// files the task.
    pub task_id: i64,
    /// Originating identity: Matrix user id or canonical agent handle.
    pub sender: String,
    /// Stamped by the dispatcher from its roster, never trusted from the sender.
    pub sender_class: SenderClass,
    /// Canonical lowercase handle of the agent this card is addressed to.
    pub recipient: String,
    /// 0=P0 (highest) .. 3=P3 — same scale and direction as the tracker.
    pub priority: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(default)]
    pub requires_reply: bool,
    pub interrupt_policy: InterruptPolicy,
    /// The instruction / message content, VERBATIM (forward, don't paraphrase).
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<LeasePublic>,
    /// RFC 3339 UTC.
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

/// Canonical handle check (contract rule 0.4): `^[a-z0-9][a-z0-9._-]*$`.
pub fn is_canonical_handle(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical_card_json() -> serde_json::Value {
        serde_json::json!({
            "schema_version": 1,
            "card_id": "6dd60ac5-84ac-4e0e-a91d-3ab88b164df8",
            "task_id": 670,
            "sender": "@parker:petalnet.example",
            "sender_class": "principal",
            "recipient": "janet",
            "priority": 1,
            "thread": "$abc123",
            "requires_reply": true,
            "interrupt_policy": "principal_command",
            "body": "restart the canary check",
            "capability": "matrix-write",
            "created_at": "2026-07-12T11:00:00Z"
        })
    }

    #[test]
    fn canonical_card_round_trips() {
        let card: TaskCard = serde_json::from_value(canonical_card_json()).unwrap();
        assert_eq!(card.sender_class, SenderClass::Principal);
        assert_eq!(card.interrupt_policy, InterruptPolicy::PrincipalCommand);
        let back = serde_json::to_value(&card).unwrap();
        assert_eq!(back, canonical_card_json());
    }

    #[test]
    fn unknown_field_is_rejected() {
        let mut v = canonical_card_json();
        v["claim_token"] = serde_json::json!("deadbeef");
        let err = serde_json::from_value::<TaskCard>(v).unwrap_err();
        assert!(err.to_string().contains("unknown field"), "{err}");
    }

    #[test]
    fn bad_interrupt_policy_is_rejected() {
        let mut v = canonical_card_json();
        v["interrupt_policy"] = serde_json::json!("shout_loudly");
        assert!(serde_json::from_value::<TaskCard>(v).is_err());
    }

    #[test]
    fn lease_public_never_carries_claim_token() {
        let v = serde_json::json!({
            "schema_version": 1,
            "task_id": 5,
            "worker": "janet",
            "lease_expires_at": "2026-07-12T11:30:00Z",
            "claim_token": "d3b07384-d9a0-4c9c-8c5b-8f1f0e2a3b4c"
        });
        assert!(serde_json::from_value::<LeasePublic>(v).is_err());
    }

    #[test]
    fn requires_reply_defaults_false() {
        let mut v = canonical_card_json();
        v.as_object_mut().unwrap().remove("requires_reply");
        let card: TaskCard = serde_json::from_value(v).unwrap();
        assert!(!card.requires_reply);
    }

    #[test]
    fn canonical_handle_rules() {
        assert!(is_canonical_handle("janet"));
        assert!(is_canonical_handle("box-14.local"));
        assert!(!is_canonical_handle("Janet"));
        assert!(!is_canonical_handle("-janet"));
        assert!(!is_canonical_handle(""));
        assert!(!is_canonical_handle("ja net"));
    }
}
