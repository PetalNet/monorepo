//! Message dispatch: routes room messages to plugins.
//!
//! One handler per incoming `m.room.message`:
//!
//! 1. `!command` tokens → the matching plugin's `run`, dev-routing aware;
//! 2. `@mention` tokens (case-insensitive, punctuation-tolerant) → ditto;
//! 3. every passive plugin (`handles_room_messages`) gets the event.
//!
//! Every plugin invocation goes through
//! [`courier_core::supervise::spawn_supervised`]: its own task, a hard
//! budget (plugin-declared or default), panic containment. One bad event or
//! plugin can never freeze or crash the relay.

use core::time::Duration;
use std::{collections::HashSet, path::PathBuf, sync::Arc};

use matrix_sdk::{
    Client,
    room::Room,
    ruma::events::room::message::{MessageType, OriginalSyncRoomMessageEvent},
};
use tracing::{debug, info};

use courier_core::{
    plugin::{PluginContext, PluginEntry, PluginRegistry, RoomMessageMeta},
    supervise::spawn_supervised,
    text::truncate,
    watchdog::Heartbeat,
};

/// Default budget for a command/mention plugin invocation. Plugins whose
/// legitimate worst case exceeds this override it via
/// [`courier_core::plugin::Plugin::command_budget`].
const COMMAND_BUDGET: Duration = Duration::from_secs(60);
/// Default budget for passive handlers; overridable via
/// [`courier_core::plugin::Plugin::passive_budget`] (the relay does).
const PASSIVE_BUDGET: Duration = Duration::from_secs(300);

/// Immutable routing state shared by every handler invocation.
#[derive(Debug)]
pub struct Dispatcher {
    /// The plugin registry.
    pub registry: Arc<PluginRegistry>,
    /// Whether dev mode is active.
    pub dev_active: bool,
    /// The configured dev id, if any.
    pub dev_id: Option<Arc<str>>,
    /// Directory for per-room history logs.
    pub history_dir: Arc<PathBuf>,
}

/// Install the room-message handler on `client`.
///
/// The handler beats `heartbeat` on every message: a large post-outage
/// catch-up batch can take a long time inside one `sync_once`, and progress
/// there must count as liveness or the watchdog would kill a healthy
/// catch-up.
pub fn install(client: &Client, dispatcher: Arc<Dispatcher>, heartbeat: Heartbeat) {
    client.add_event_handler(
        async move |ev: OriginalSyncRoomMessageEvent, room: Room, client: Client| {
            heartbeat.beat();
            dispatcher.handle_message(&client, &room, &ev);
        },
    );
}

impl Dispatcher {
    /// Route one room message. Synchronous: all plugin work is spawned into
    /// supervised tasks, so the sync loop is never blocked by a handler.
    fn handle_message(&self, client: &Client, room: &Room, ev: &OriginalSyncRoomMessageEvent) {
        let Some(own_id) = client.user_id() else {
            return;
        };

        let msg_kind = message_kind(&ev.content.msgtype);
        let body_opt = message_body(&ev.content.msgtype);
        let body_snippet = body_opt.map(|b| truncate(b, 200));
        info!(
            room_id = %room.room_id(),
            sender = %ev.sender,
            kind = %msg_kind,
            body = ?body_snippet,
            "Incoming message"
        );

        let is_self = ev.sender == own_id;
        let mut triggered_plugins: HashSet<String> = HashSet::new();

        if !is_self && let Some(body) = body_opt.map(str::trim) {
            if let Some(plugin_id) = self.dispatch_command(client, room, ev, body) {
                triggered_plugins.insert(plugin_id);
            }
            if let Some(plugin_id) = self.dispatch_mention(client, room, ev, body) {
                triggered_plugins.insert(plugin_id);
            }
        }

        let meta = RoomMessageMeta {
            body: body_opt.map(std::borrow::ToOwned::to_owned),
            triggered_plugins: Arc::new(triggered_plugins),
        };
        self.dispatch_passive(client, room, ev, &meta, is_self);
    }

    fn context(
        &self,
        client: &Client,
        room: &Room,
        ev: &OriginalSyncRoomMessageEvent,
    ) -> PluginContext {
        PluginContext {
            client: client.clone(),
            room: room.clone(),
            dev_active: self.dev_active,
            dev_id: self.dev_id.clone(),
            registry: Arc::clone(&self.registry),
            history_dir: Arc::clone(&self.history_dir),
            trigger_event: Some(Arc::new(ev.clone())),
        }
    }

    /// Whether `entry` may run right now; logs the reason when blocked.
    fn gate(&self, entry: &PluginEntry, routing: DevRouting, what: &'static str) -> bool {
        let plugin_id = &entry.spec.id;
        match routing {
            DevRouting::OtherDev => {
                info!(plugin = %plugin_id, what, reason = "other-dev", "Ignoring trigger");
                false
            }
            DevRouting::Dev if !self.dev_active => {
                info!(plugin = %plugin_id, what, reason = "dev-in-prod", "Ignoring trigger");
                false
            }
            DevRouting::Prod if self.dev_active => {
                info!(plugin = %plugin_id, what, reason = "prod-in-dev", "Ignoring trigger");
                false
            }
            DevRouting::Prod | DevRouting::Dev => {
                if entry
                    .spec
                    .dev_only
                    .unwrap_or_else(|| entry.plugin.dev_only())
                    && !self.dev_active
                {
                    info!(plugin = %plugin_id, what, reason = "dev-only-in-prod", "Ignoring trigger");
                    return false;
                }
                if !self.registry.is_enabled(plugin_id) {
                    info!(plugin = %plugin_id, what, reason = "disabled", "Ignoring trigger");
                    return false;
                }
                true
            }
        }
    }

    /// `!command` routing. Returns the triggered plugin id, if any.
    fn dispatch_command(
        &self,
        client: &Client,
        room: &Room,
        ev: &OriginalSyncRoomMessageEvent,
        body: &str,
    ) -> Option<String> {
        if !body.starts_with('!') {
            return None;
        }
        let mut parts = body.splitn(2, ' ');
        let cmd = parts.next().unwrap_or("");
        let args_raw = parts.next().unwrap_or("").trim();
        let (normalized_cmd, routing) = classify_command_token(cmd, self.dev_id.as_deref());
        info!(
            cmd = %cmd,
            normalized_cmd = %normalized_cmd,
            route = ?routing,
            args = %args_raw,
            dev_active = self.dev_active,
            "Parsed command token"
        );
        let entry = self.registry.entry_by_command(&normalized_cmd)?;
        if !self.gate(&entry, routing, "command") {
            return None;
        }
        let plugin_id = entry.spec.id.clone();
        spawn_run(
            "command",
            &entry,
            self.context(client, room, ev),
            args_raw.to_owned(),
        );
        Some(plugin_id)
    }

    /// `@mention` routing: first actionable mention wins. Returns the
    /// triggered plugin id, if any.
    fn dispatch_mention(
        &self,
        client: &Client,
        room: &Room,
        ev: &OriginalSyncRoomMessageEvent,
        body: &str,
    ) -> Option<String> {
        for token_raw in body.split_whitespace() {
            // Fast skip: tokens without '@' cannot be mentions.
            if !token_raw.contains('@') {
                continue;
            }
            let Some(token) = trim_mention_token(token_raw) else {
                continue;
            };
            let (normalized_mention, routing) =
                classify_mention_token(token, self.dev_id.as_deref());
            let key = normalized_mention.to_lowercase();
            debug!(token_raw = %token_raw, token = %token, key = %key, route = ?routing, "Checking mention token");

            let Some(entry) = self.registry.entry_by_mention(&key) else {
                continue;
            };
            if !self.gate(&entry, routing, "mention") {
                // Keep scanning for a later valid mention.
                continue;
            }
            info!(plugin = %entry.spec.id, token = %token, "Mention matched");
            let plugin_id = entry.spec.id.clone();
            // Use the FULL body as the prompt so earlier words are preserved
            // (the AI can see the initiator and routing prefix).
            spawn_run(
                "mention",
                &entry,
                self.context(client, room, ev),
                body.to_owned(),
            );
            // Handle only the first mention that targets this instance.
            return Some(plugin_id);
        }
        debug!("No actionable mention found in message");
        None
    }

    /// Fan the event out to every passive plugin.
    fn dispatch_passive(
        &self,
        client: &Client,
        room: &Room,
        ev: &OriginalSyncRoomMessageEvent,
        meta: &RoomMessageMeta,
        is_self: bool,
    ) {
        for (plugin_id, entry) in self.registry.entries() {
            if !entry.plugin.handles_room_messages() {
                continue;
            }
            if is_self && !entry.plugin.wants_own_messages() {
                continue;
            }
            if entry
                .spec
                .dev_only
                .unwrap_or_else(|| entry.plugin.dev_only())
                && !self.dev_active
            {
                continue;
            }
            if !self.registry.is_enabled(&plugin_id) {
                continue;
            }
            let plugin = Arc::clone(&entry.plugin);
            let spec = entry.spec.clone();
            let ctx = self.context(client, room, ev);
            let ev_p = ev.clone();
            let meta_p = meta.clone();
            let budget = plugin.passive_budget().unwrap_or(PASSIVE_BUDGET);
            spawn_supervised("passive", plugin_id, budget, async move {
                plugin.on_room_message(&ctx, &ev_p, &spec, &meta_p).await
            });
        }
    }
}

/// Spawn one supervised command/mention invocation with the plugin's own
/// budget (or the default).
fn spawn_run(what: &'static str, entry: &PluginEntry, ctx: PluginContext, args: String) {
    let plugin = Arc::clone(&entry.plugin);
    let spec = entry.spec.clone();
    let budget = plugin.command_budget().unwrap_or(COMMAND_BUDGET);
    spawn_supervised(what, entry.spec.id.clone(), budget, async move {
        plugin.run(&ctx, &args, &spec).await
    });
}

const fn message_kind(msgtype: &MessageType) -> &'static str {
    match msgtype {
        MessageType::Text(_) => "text",
        MessageType::Notice(_) => "notice",
        MessageType::Emote(_) => "emote",
        MessageType::Image(_) => "image",
        MessageType::File(_) => "file",
        MessageType::Audio(_) => "audio",
        MessageType::Video(_) => "video",
        MessageType::Location(_)
        | MessageType::ServerNotice(_)
        | MessageType::VerificationRequest(_)
        | _ => "other",
    }
}

const fn message_body(msgtype: &MessageType) -> Option<&str> {
    match msgtype {
        MessageType::Text(t) => Some(t.body.as_str()),
        MessageType::Notice(n) => Some(n.body.as_str()),
        MessageType::Audio(_)
        | MessageType::Emote(_)
        | MessageType::File(_)
        | MessageType::Image(_)
        | MessageType::Location(_)
        | MessageType::ServerNotice(_)
        | MessageType::Video(_)
        | MessageType::VerificationRequest(_)
        | _ => None,
    }
}

/// Trim wrapping punctuation and possessive suffixes off a candidate
/// mention token; `None` if it doesn't start with `@` afterwards.
fn trim_mention_token(token_raw: &str) -> Option<&str> {
    let token_leading = token_raw.trim_start_matches(['(', '[', '{', '<', '"', '\'']);
    let mut token = token_leading.trim_end_matches([
        ':', ',', '.', ';', '!', '?', '…', '—', '–', ')', ']', '}', '>', '"', '\'',
    ]);
    // Strip possessive suffixes like @ai's or @ai’s.
    if let Some(t) = token
        .strip_suffix("'s")
        .or_else(|| token.strip_suffix("’s"))
    {
        token = t;
    }
    token.starts_with('@').then_some(token)
}

/// Where a command/mention token routes in dev/prod terms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevRouting {
    /// Untagged: handled by the prod instance.
    Prod,
    /// Tagged with OUR dev id: handled by this dev instance.
    Dev,
    /// Tagged with someone else's dev id: ignored.
    OtherDev,
}

/// Normalize a `!devid.command` token and classify its routing.
pub fn classify_command_token(cmd: &str, dev_id: Option<&str>) -> (String, DevRouting) {
    if let Some(stripped) = cmd.strip_prefix('!')
        && let Some((dev_tag, remainder)) = stripped.split_once('.')
    {
        if remainder.is_empty() {
            return (cmd.to_owned(), DevRouting::OtherDev);
        }
        let normalized = format!("!{remainder}");
        let routing = match dev_id {
            Some(expected) if expected.eq_ignore_ascii_case(dev_tag) => DevRouting::Dev,
            _ => DevRouting::OtherDev,
        };
        return (normalized, routing);
    }
    (cmd.to_owned(), DevRouting::Prod)
}

/// Normalize an `@devid.name` token and classify its routing.
pub fn classify_mention_token(token: &str, dev_id: Option<&str>) -> (String, DevRouting) {
    if let Some(stripped) = token.strip_prefix('@')
        && let Some((dev_tag, remainder)) = stripped.split_once('.')
    {
        if remainder.is_empty() {
            return (token.to_owned(), DevRouting::OtherDev);
        }
        let normalized = format!("@{remainder}");
        let routing = match dev_id {
            Some(expected) if expected.eq_ignore_ascii_case(dev_tag) => DevRouting::Dev,
            _ => DevRouting::OtherDev,
        };
        return (normalized, routing);
    }
    (token.to_owned(), DevRouting::Prod)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_command_routes_to_prod() {
        let (cmd, route) = classify_command_token("!ping", None);
        assert_eq!(cmd, "!ping");
        assert_eq!(route, DevRouting::Prod);
    }

    #[test]
    fn dev_tagged_command_routes_by_dev_id() {
        let (cmd, route) = classify_command_token("!claire.ping", Some("claire"));
        assert_eq!(cmd, "!ping");
        assert_eq!(route, DevRouting::Dev);

        let (cmd, route) = classify_command_token("!other.ping", Some("claire"));
        assert_eq!(cmd, "!ping");
        assert_eq!(route, DevRouting::OtherDev);

        let (_, route) = classify_command_token("!CLAIRE.ping", Some("claire"));
        assert_eq!(route, DevRouting::Dev, "dev id compare is case-insensitive");
    }

    #[test]
    fn empty_remainder_is_other_dev() {
        let (cmd, route) = classify_command_token("!claire.", Some("claire"));
        assert_eq!(cmd, "!claire.");
        assert_eq!(route, DevRouting::OtherDev);
    }

    #[test]
    fn mention_tokens_classify_like_commands() {
        let (m, route) = classify_mention_token("@ai", Some("claire"));
        assert_eq!(m, "@ai");
        assert_eq!(route, DevRouting::Prod);

        let (m, route) = classify_mention_token("@claire.ai", Some("claire"));
        assert_eq!(m, "@ai");
        assert_eq!(route, DevRouting::Dev);
    }

    #[test]
    fn mention_trimming_handles_punctuation_and_possessive() {
        assert_eq!(trim_mention_token("(@ai)"), Some("@ai"));
        assert_eq!(trim_mention_token("@ai:"), Some("@ai"));
        assert_eq!(trim_mention_token("@ai's"), Some("@ai"));
        assert_eq!(trim_mention_token("@ai’s"), Some("@ai"));
        assert_eq!(
            trim_mention_token("ai@example.com"),
            None,
            "emails are not mentions"
        );
        assert_eq!(trim_mention_token("plain"), None);
    }
}
