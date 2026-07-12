//! Fleet-event snapshot writer (BA5) — the box-agent as a fleet-event
//! PRODUCER per the v1 contract: canonical lowercase handle, canonical host,
//! snapshot file = latest event, `offline` never written (consumer-derived).

use std::path::Path;

use serde::Serialize;

pub const FLEET_EVENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    SessionStart,
    PreTool,
    PostTool,
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Alive,
    Working,
    Idle,
}

#[derive(Debug, Clone, Serialize)]
pub struct FleetEvent {
    pub schema_version: u32,
    pub handle: String,
    pub host: Option<String>,
    pub event: EventKind,
    pub status: Status,
    pub current_tool: Option<String>,
    pub task_id: Option<i64>,
    pub session_id: Option<String>,
    pub started_at: String,
    pub updated_at: String,
}

/// Write the snapshot (`<dir>/<handle>.json`, atomic tmp+rename — a reader
/// never sees a torn file).
pub fn write_snapshot(dir: &Path, event: &FleetEvent) -> Result<(), String> {
    if !dispatcher::card::is_canonical_handle(&event.handle) {
        return Err(format!("non-canonical handle {:?}", event.handle));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", event.handle));
    let tmp = path.with_extension("tmp");
    let body = serde_json::to_string_pretty(event).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> FleetEvent {
        FleetEvent {
            schema_version: FLEET_EVENT_SCHEMA_VERSION,
            handle: "box-a".into(),
            host: Some(".14".into()),
            event: EventKind::PostTool,
            status: Status::Working,
            current_tool: None,
            task_id: Some(42),
            session_id: None,
            started_at: "2026-07-12T11:00:00Z".into(),
            updated_at: "2026-07-12T11:05:00Z".into(),
        }
    }

    #[test]
    fn snapshot_is_the_latest_event_and_contract_shaped() {
        let dir = tempfile::tempdir().unwrap();
        write_snapshot(dir.path(), &event()).unwrap();
        let mut newer = event();
        newer.status = Status::Idle;
        newer.task_id = None;
        newer.event = EventKind::Stop;
        write_snapshot(dir.path(), &newer).unwrap();
        let raw = std::fs::read_to_string(dir.path().join("box-a.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["schema_version"], 1);
        assert_eq!(v["status"], "idle", "overwritten = latest event");
        assert_eq!(v["event"], "stop");
        assert_eq!(v["host"], ".14");
        // The producer NEVER writes 'offline' — the enum makes it impossible,
        // and the wire shape has no such value.
        assert!(raw.contains("idle") && !raw.contains("offline"));
    }

    #[test]
    fn hostile_handle_never_becomes_a_path() {
        let dir = tempfile::tempdir().unwrap();
        let mut e = event();
        e.handle = "../evil".into();
        assert!(write_snapshot(dir.path(), &e).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
