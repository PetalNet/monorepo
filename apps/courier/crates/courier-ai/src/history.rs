//! Per-room chat history logs.
//!
//! Every text-bearing message is appended to `<history_dir>/<room>.log` as
//! `[rfc3339] Name:body`; the AI plugin reads the tail back as conversation
//! context. File naming and line format are wire-compatible with the
//! previous generation, so existing history files keep working.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Once,
};

use courier_core::{plugin::PluginContext, text::sanitize_line};
use matrix_sdk::{
    Client,
    room::{MessagesOptions, Room},
    ruma::{
        MilliSecondsSinceUnixEpoch, OwnedUserId, RoomId,
        events::{
            AnySyncMessageLikeEvent, AnySyncTimelineEvent,
            room::message::{MessageType, OriginalSyncRoomMessageEvent, SyncRoomMessageEvent},
        },
        serde::Raw,
    },
};
use tracing::{info, warn};

static BACKFILL_ONCE: Once = Once::new();

/// Spawn the history backfill task at most once per process.
pub fn spawn_backfill_once(client: Client, history_dir: PathBuf, limit: u64) {
    BACKFILL_ONCE.call_once(|| {
        tokio::spawn(async move {
            backfill_all(client, history_dir, limit).await;
        });
    });
}

/// Append the live message to the room's history log.
pub async fn record(ctx: &PluginContext, event: &OriginalSyncRoomMessageEvent, body: &str) {
    let sanitized = sanitize_line(body, 400);
    if sanitized.is_empty() {
        return;
    }

    let sender_name = match ctx.room.get_member(&event.sender).await {
        Ok(Some(member)) => member
            .display_name()
            .map_or_else(|| event.sender.localpart().to_owned(), ToOwned::to_owned),
        Ok(None) | Err(_) => event.sender.localpart().to_owned(),
    };
    let timestamp = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned());
    let line = format!("[{timestamp}] {sender_name}:{sanitized}");
    append_history_line(ctx.history_dir.as_ref(), ctx.room.room_id(), &line);
}

/// Path of the history log for `room_id` (room id sanitized for filesystems).
pub fn history_path(history_dir: &Path, room_id: &RoomId) -> PathBuf {
    let mut name = room_id.as_str().to_owned();
    name = name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    history_dir.join(format!("{name}.log"))
}

/// Append one line to the room's history log, creating dirs as needed.
pub fn append_history_line(history_dir: &Path, room_id: &RoomId, line: &str) {
    let path = history_path(history_dir, room_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut buf = line.to_owned();
    buf.push('\n');
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, buf.as_bytes()));
}

/// Read the last `n` lines of the room's history log.
pub fn read_last_history(history_dir: &Path, room_id: &RoomId, n: usize) -> Vec<String> {
    let path = history_path(history_dir, room_id);
    if let Ok(data) = std::fs::read_to_string(&path) {
        let lines: Vec<String> = data.lines().map(ToOwned::to_owned).collect();
        let len = lines.len();
        let start = len.saturating_sub(n);
        return lines[start..].to_vec();
    }
    Vec::new()
}

async fn history_line_from_raw(
    room: &Room,
    raw_event: Raw<AnySyncTimelineEvent>,
    name_cache: &mut HashMap<OwnedUserId, String>,
) -> Option<String> {
    let event = raw_event.deserialize().ok()?;
    let AnySyncTimelineEvent::MessageLike(message_like) = event else {
        return None;
    };
    let AnySyncMessageLikeEvent::RoomMessage(msg) = message_like else {
        return None;
    };
    let SyncRoomMessageEvent::Original(OriginalSyncRoomMessageEvent {
        sender,
        content,
        origin_server_ts,
        ..
    }) = msg
    else {
        return None;
    };

    let body = match &content.msgtype {
        MessageType::Text(inner) => Some(inner.body.as_str()),
        MessageType::Notice(inner) => Some(inner.body.as_str()),
        MessageType::Emote(inner) => Some(inner.body.as_str()),
        MessageType::Audio(_)
        | MessageType::File(_)
        | MessageType::Image(_)
        | MessageType::Location(_)
        | MessageType::ServerNotice(_)
        | MessageType::Video(_)
        | MessageType::VerificationRequest(_)
        | _ => None,
    }?;

    let sanitized = sanitize_line(body, 400);
    if sanitized.is_empty() {
        return None;
    }

    let timestamp = format_timestamp(Some(origin_server_ts));
    let sender_name = resolve_display_name(room, name_cache, &sender).await;
    Some(format!("[{timestamp}] {sender_name}:{sanitized}"))
}

async fn resolve_display_name(
    room: &Room,
    cache: &mut HashMap<OwnedUserId, String>,
    user_id: &OwnedUserId,
) -> String {
    if let Some(name) = cache.get(user_id) {
        return name.clone();
    }
    let display = match room.get_member(user_id).await {
        Ok(Some(member)) => member
            .display_name()
            .map_or_else(|| user_id.localpart().to_owned(), ToOwned::to_owned),
        Ok(None) | Err(_) => user_id.localpart().to_owned(),
    };
    cache.insert(user_id.clone(), display.clone());
    display
}

fn format_timestamp(ts: Option<MilliSecondsSinceUnixEpoch>) -> String {
    if let Some(ts) = ts
        && let Some(formatted) = timestamp_to_rfc3339(ts)
    {
        return formatted;
    }
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

fn timestamp_to_rfc3339(ts: MilliSecondsSinceUnixEpoch) -> Option<String> {
    let millis = i128::from(ts.get());
    let nanos = millis.checked_mul(1_000_000)?;
    let dt = time::OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()?;
    dt.format(&time::format_description::well_known::Rfc3339)
        .ok()
}

async fn backfill_all(client: Client, history_dir: PathBuf, limit: u64) {
    if limit == 0 {
        info!(dir = %history_dir.display(), "AI backfill skipped because limit is zero");
        return;
    }

    let rooms = client.joined_rooms();
    info!(rooms = rooms.len(), limit, dir = %history_dir.display(), "AI backfill start");

    for room in rooms {
        let room_id = room.room_id().to_owned();
        let mut from_token = room.last_prev_batch();
        if from_token.is_none() {
            info!(room = %room_id, "AI backfill: no prev_batch token; starting from timeline end");
        }

        let mut remaining = limit;
        let mut total_appended = 0usize;
        let mut page_counter = 0usize;
        let mut name_cache: HashMap<OwnedUserId, String> = HashMap::new();

        while remaining > 0 {
            page_counter += 1;
            let batch = remaining.min(50);
            let mut options = MessagesOptions::backward();
            options.from.clone_from(&from_token);
            options.limit = u32::try_from(batch).unwrap_or(50).into();

            let response = match room.messages(options).await {
                Ok(res) => res,
                Err(err) => {
                    warn!(room = %room_id, error = %err, "AI backfill: room/messages request failed");
                    break;
                }
            };

            let next_token = response.end.clone();
            if response.chunk.is_empty() {
                info!(room = %room_id, pages = page_counter, fetched = total_appended, "AI backfill: empty chunk returned");
                break;
            }

            let mut appended_this_page = 0usize;
            for timeline_event in response.chunk.into_iter().rev() {
                if remaining == 0 {
                    break;
                }
                if let Some(line) =
                    history_line_from_raw(&room, timeline_event.into_raw(), &mut name_cache).await
                {
                    append_history_line(&history_dir, &room_id, &line);
                    appended_this_page += 1;
                    total_appended += 1;
                    remaining = remaining.saturating_sub(1);
                }
            }

            info!(
                room = %room_id,
                page = page_counter,
                appended = appended_this_page,
                total = total_appended,
                remaining,
                "AI backfill page complete"
            );

            if remaining == 0 {
                break;
            }

            let Some(token) = next_token else { break };
            if token.is_empty() || from_token.as_deref() == Some(token.as_str()) {
                break;
            }
            from_token = Some(token);
        }

        info!(room = %room_id, fetched = total_appended, "AI backfill room done");
    }

    info!("AI backfill complete");
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::ruma::OwnedRoomId;

    #[test]
    fn history_path_sanitizes_room_id_like_previous_generation() {
        let dir = Path::new("/tmp/hist");
        let room_id: OwnedRoomId = "!abc:server.org".try_into().expect("valid room id");
        let path = history_path(dir, &room_id);
        assert_eq!(path, Path::new("/tmp/hist/!abc_server.org.log"));
    }
}
