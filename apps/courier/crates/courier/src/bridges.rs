//! Beeper bridge health, read from `https://api.beeper.com/whoami`.
//!
//! The relay only works if the bridges feeding the bot's rooms are logged in.
//! A fresh Matrix sync says nothing about that, so the Kuma push also
//! requires every bridge in `COURIER_REQUIRED_BRIDGES` to have a live login.

use core::time::Duration;

use serde_json::Value;

/// Beeper's account API; accepts the Matrix access token as a bearer.
pub const WHOAMI_URL: &str = "https://api.beeper.com/whoami";

/// Deadline for one whoami request.
pub const WHOAMI_TIMEOUT: Duration = Duration::from_secs(10);

/// Remote (login) states that mean messages are flowing.
const OK_STATES: [&str; 2] = ["CONNECTED", "BACKFILLING"];

/// Check every required bridge has at least one remote login in an OK state.
/// `Err` carries a short, secret-free reason naming each failing bridge.
pub fn check_bridges(required: &[String], whoami: &Value) -> Result<(), String> {
    let bridges = whoami.pointer("/user/bridges").and_then(Value::as_object);
    let mut problems = Vec::new();
    for name in required {
        let Some(bridge) = bridges.and_then(|b| b.get(name)) else {
            problems.push(format!("{name}: not found"));
            continue;
        };
        let remotes = bridge.get("remoteState").and_then(Value::as_object);
        let states: Vec<&str> = remotes
            .into_iter()
            .flatten()
            .map(|(_, r)| {
                r.get("state_event")
                    .and_then(Value::as_str)
                    .unwrap_or("UNKNOWN")
            })
            .collect();
        if states.iter().any(|s| OK_STATES.contains(s)) {
            continue;
        }
        let why = states.first().map_or_else(
            || {
                bridge
                    .pointer("/bridgeState/stateEvent")
                    .and_then(Value::as_str)
                    .map_or_else(|| "no login".to_owned(), |s| format!("no login ({s})"))
            },
            |s| (*s).to_owned(),
        );
        problems.push(format!("{name}: {why}"));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

/// What to push this cycle. `Skip` means the sync is stale: send nothing and
/// let Kuma time out.
#[derive(Debug, PartialEq, Eq)]
pub enum PushDecision {
    Skip,
    Up,
    Down(String),
}

/// Combine sync freshness with the bridge check. `bridges` is `None` when no
/// bridges are required, and `Err` when whoami could not be fetched, which
/// is down (never fail-open).
pub fn decide(sync_fresh: bool, bridges: Option<Result<(), String>>) -> PushDecision {
    if !sync_fresh {
        return PushDecision::Skip;
    }
    match bridges {
        None | Some(Ok(())) => PushDecision::Up,
        Some(Err(msg)) => PushDecision::Down(msg),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn req() -> Vec<String> {
        vec!["sh-instagram".into(), "sh-gchat".into()]
    }

    fn whoami(insta: &Value, gchat: &Value) -> Value {
        json!({"user": {"bridges": {
            "sh-instagram": {"bridgeState": {"stateEvent": "RUNNING"}, "remoteState": insta},
            "sh-gchat": {"bridgeState": {"stateEvent": "RUNNING"}, "remoteState": gchat},
        }}})
    }

    #[test]
    fn connected_is_ok() {
        let w = whoami(
            &json!({"1": {"state_event": "CONNECTED"}}),
            &json!({"2": {"state_event": "BACKFILLING"}}),
        );
        assert_eq!(check_bridges(&req(), &w), Ok(()));
    }

    #[test]
    fn logged_out_bridges_fail_and_are_named() {
        let w = whoami(
            &json!({"1": {"state_event": "BAD_CREDENTIALS"}}),
            &json!({}),
        );
        let err = check_bridges(&req(), &w).unwrap_err();
        assert!(err.contains("sh-instagram: BAD_CREDENTIALS"), "{err}");
        assert!(err.contains("sh-gchat: no login (RUNNING)"), "{err}");
    }

    #[test]
    fn one_good_login_suffices_and_missing_bridge_fails() {
        let w = whoami(
            &json!({"1": {"state_event": "BAD_CREDENTIALS"}, "3": {"state_event": "CONNECTED"}}),
            &json!({"2": {"state_event": "TRANSIENT_DISCONNECT"}}),
        );
        let err = check_bridges(&req(), &w).unwrap_err();
        assert!(!err.contains("sh-instagram"), "{err}");
        assert!(err.contains("sh-gchat: TRANSIENT_DISCONNECT"), "{err}");
        let err = check_bridges(&req(), &json!({})).unwrap_err();
        assert!(err.contains("sh-gchat: not found"), "{err}");
    }

    #[test]
    fn decision_matrix() {
        assert_eq!(decide(true, None), PushDecision::Up);
        assert_eq!(decide(true, Some(Ok(()))), PushDecision::Up);
        assert_eq!(
            decide(true, Some(Err("x".into()))),
            PushDecision::Down("x".into())
        );
        assert_eq!(decide(false, Some(Ok(()))), PushDecision::Skip);
        assert_eq!(decide(false, None), PushDecision::Skip);
    }
}
