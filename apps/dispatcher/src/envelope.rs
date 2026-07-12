//! Backchannel RPC envelope — serde mirror of
//! `apps/manager/docs/contracts/schemas/backchannel-rpc.schema.json` (v1).
//!
//! Transport-agnostic on purpose: the same envelope rides doorman (wss +
//! yamux + Noise) or the Matrix never-dark floor. `id` doubles as the
//! idempotency key — receivers de-duplicate on it, and the dispatcher retries
//! a delivery with the SAME id after redial/backoff.
//!
//! The canonical Rust envelope crate lands with N1.4 in the doorman repo
//! (DP3); these types are the dispatcher-side mirror until that crate is
//! consumable from the monorepo.

use serde::{Deserialize, Serialize};

pub const RPC_SCHEMA_VERSION: u32 = 1;

/// Method the dispatcher uses to deliver a task card.
pub const METHOD_TASK_DISPATCH: &str = "task.dispatch";
/// Method agents/managers use to report capacity (provides[], free slots).
pub const METHOD_AGENT_CAPACITY: &str = "agent.capacity";
/// Method the dispatcher uses to push the compact inbox digest.
pub const METHOD_INBOX_DIGEST: &str = "inbox.digest";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeType {
    Request,
    Response,
    Event,
    Heartbeat,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcError {
    /// Stable machine-readable snake_case code.
    pub code: String,
    pub message: String,
    /// true = the caller may retry the SAME id after backoff.
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub schema_version: u32,
    /// Unique message id AND idempotency key for retried requests.
    pub id: String,
    #[serde(rename = "type")]
    pub kind: EnvelopeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// Canonical handle of the remote agent party.
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
    /// RFC 3339 UTC send time.
    pub ts: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<i64>,
}

impl Envelope {
    /// Structural conformance checks the schema's `allOf` expresses:
    /// request/event ⇒ method; response/error ⇒ in_reply_to (+ error object).
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != RPC_SCHEMA_VERSION {
            return Err(format!(
                "unsupported schema_version {}",
                self.schema_version
            ));
        }
        match self.kind {
            EnvelopeType::Request | EnvelopeType::Event => {
                if self.method.is_none() {
                    return Err(format!("{:?} envelope requires method", self.kind));
                }
            }
            EnvelopeType::Response => {
                if self.in_reply_to.is_none() {
                    return Err("response envelope requires in_reply_to".into());
                }
            }
            EnvelopeType::Error => {
                if self.in_reply_to.is_none() {
                    return Err("error envelope requires in_reply_to".into());
                }
                if self.error.is_none() {
                    return Err("error envelope requires error object".into());
                }
            }
            EnvelopeType::Heartbeat => {}
        }
        Ok(())
    }

    /// Build the `task.dispatch` request that carries a task card to `agent`.
    /// The envelope id is minted once per card delivery attempt-set: retries
    /// re-send the SAME envelope (idempotency on id).
    pub fn task_dispatch(
        agent: &str,
        task_id: i64,
        card_json: serde_json::Value,
        now_rfc3339: String,
    ) -> Envelope {
        Envelope {
            schema_version: RPC_SCHEMA_VERSION,
            id: uuid::Uuid::new_v4().to_string(),
            kind: EnvelopeType::Request,
            method: Some(METHOD_TASK_DISPATCH.into()),
            agent: agent.to_string(),
            task_id: Some(task_id),
            in_reply_to: None,
            payload: Some(serde_json::json!({ "card": card_json })),
            error: None,
            ts: now_rfc3339,
            deadline_ms: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(kind: EnvelopeType) -> Envelope {
        Envelope {
            schema_version: 1,
            id: "0d6f9a5e-3f0a-4c1b-9a56-1c2d3e4f5a6b".into(),
            kind,
            method: None,
            agent: "janet".into(),
            task_id: None,
            in_reply_to: None,
            payload: None,
            error: None,
            ts: "2026-07-12T11:00:00Z".into(),
            deadline_ms: None,
        }
    }

    #[test]
    fn request_requires_method() {
        assert!(base(EnvelopeType::Request).validate().is_err());
        let mut e = base(EnvelopeType::Request);
        e.method = Some("task.dispatch".into());
        assert!(e.validate().is_ok());
    }

    #[test]
    fn event_requires_method() {
        assert!(base(EnvelopeType::Event).validate().is_err());
    }

    #[test]
    fn response_requires_in_reply_to() {
        assert!(base(EnvelopeType::Response).validate().is_err());
        let mut e = base(EnvelopeType::Response);
        e.in_reply_to = Some("abc".into());
        assert!(e.validate().is_ok());
    }

    #[test]
    fn error_requires_in_reply_to_and_error() {
        let mut e = base(EnvelopeType::Error);
        e.in_reply_to = Some("abc".into());
        assert!(e.validate().is_err(), "error object still missing");
        e.error = Some(RpcError {
            code: "lease_lost".into(),
            message: "fence advanced".into(),
            retryable: false,
        });
        assert!(e.validate().is_ok());
    }

    #[test]
    fn heartbeat_needs_nothing_extra() {
        assert!(base(EnvelopeType::Heartbeat).validate().is_ok());
    }

    #[test]
    fn wire_shape_matches_contract() {
        let e = Envelope::task_dispatch(
            "janet",
            670,
            serde_json::json!({"stub": true}),
            "2026-07-12T11:00:00Z".into(),
        );
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "request");
        assert_eq!(v["method"], "task.dispatch");
        assert_eq!(v["task_id"], 670);
        // Optional-absent fields are omitted, not null (additionalProperties: false).
        assert!(v.get("in_reply_to").is_none());
        assert!(v.get("error").is_none());
        // Round-trip.
        let back: Envelope = serde_json::from_value(v).unwrap();
        assert_eq!(back, e);
        assert!(back.validate().is_ok());
    }

    #[test]
    fn unknown_field_rejected() {
        let v = serde_json::json!({
            "schema_version": 1,
            "id": "x",
            "type": "heartbeat",
            "agent": "janet",
            "ts": "2026-07-12T11:00:00Z",
            "session_token": "nope"
        });
        assert!(serde_json::from_value::<Envelope>(v).is_err());
    }
}
