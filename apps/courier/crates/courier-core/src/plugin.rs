//! The plugin contract and registry.
//!
//! Plugins never talk to the sync loop directly: the dispatcher invokes them
//! through [`crate::supervise::spawn_supervised`] with a hard budget, so the
//! contract here is deliberately simple — a trait, a spec (id + triggers +
//! free-form config), and a registry mapping commands/mentions to entries.
//!
//! The registry uses `std::sync::RwLock` (never held across an await): all
//! operations are short map lookups, and keeping them sync means they can be
//! called from any context without lock-ordering hazards.

use core::fmt::Debug;
use core::time::Duration;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, PoisonError, RwLock},
};

use anyhow::Result;
use async_trait::async_trait;
use matrix_sdk::{Client, room::Room, ruma::events::room::message::OriginalSyncRoomMessageEvent};
use serde::{Deserialize, Serialize};

/// Everything a plugin invocation gets to work with.
#[derive(Clone, Debug)]
pub struct PluginContext {
    /// The logged-in Matrix client.
    pub client: Client,
    /// The room the triggering event arrived in.
    pub room: Room,
    /// Whether this instance runs in dev mode.
    pub dev_active: bool,
    /// The configured dev id (for `!devid.command` routing), if any.
    pub dev_id: Option<Arc<str>>,
    /// The shared plugin registry (for the manager plugin).
    pub registry: Arc<PluginRegistry>,
    /// Directory for per-room history logs.
    pub history_dir: Arc<PathBuf>,
    /// The event that triggered this plugin run, if any. When set,
    /// [`crate::send::send_text`] auto-threads its reply under this event.
    /// `None` for background / non-triggered work.
    pub trigger_event: Option<Arc<OriginalSyncRoomMessageEvent>>,
}

/// Metadata the dispatcher passes alongside each room message.
#[derive(Clone, Debug)]
pub struct RoomMessageMeta {
    /// Plain-text body, if the message had one.
    pub body: Option<String>,
    /// Plugins already triggered for this event via command/mention, so
    /// passive handlers can avoid double-firing.
    pub triggered_plugins: Arc<HashSet<String>>,
}

/// A bot plugin. Implementations must be stateless or internally
/// synchronized; one instance serves all rooms.
#[async_trait]
pub trait Plugin: Send + Sync + Debug {
    /// Stable identifier used in config and the registry.
    fn id(&self) -> &'static str;
    /// One-line human help text.
    fn help(&self) -> &'static str;
    /// Default spec (triggers etc.) merged with config at startup.
    fn spec(&self) -> PluginSpec;

    /// Whether this plugin only runs in dev mode.
    fn dev_only(&self) -> bool {
        false
    }
    /// Whether [`Plugin::on_room_message`] should be called for every message.
    fn handles_room_messages(&self) -> bool {
        false
    }
    /// Whether the plugin wants to see the bot's own messages.
    fn wants_own_messages(&self) -> bool {
        false
    }
    /// Outer safety-net budget for one [`Plugin::run`] invocation (command or
    /// mention). `None` uses the dispatcher's default. Plugins whose
    /// legitimate worst case exceeds that default (e.g. a multi-turn AI tool
    /// loop) return a larger value here.
    fn command_budget(&self) -> Option<Duration> {
        None
    }
    /// Outer safety-net budget for one [`Plugin::on_room_message`]
    /// invocation. `None` uses the dispatcher's default. Plugins whose
    /// legitimate worst case exceeds that default (e.g. the relay's bounded
    /// media pipeline) return a larger value here — a too-small outer budget
    /// kills valid work mid-flight before the plugin's own bounded retries
    /// can finish.
    fn passive_budget(&self) -> Option<Duration> {
        None
    }

    /// Called once at startup (after login, before the sync loop).
    ///
    /// # Errors
    ///
    /// Implementations report startup problems; the host logs and continues.
    async fn on_startup(
        &self,
        _client: &Client,
        _spec: &PluginSpec,
        _history_dir: Arc<PathBuf>,
        _dev_active: bool,
    ) -> Result<()> {
        Ok(())
    }

    /// Handle a command/mention invocation.
    ///
    /// # Errors
    ///
    /// Implementations report handler failures; the supervisor logs them.
    async fn run(&self, ctx: &PluginContext, args: &str, spec: &PluginSpec) -> Result<()>;

    /// Handle any room message (only called when
    /// [`Plugin::handles_room_messages`] is true).
    ///
    /// # Errors
    ///
    /// Implementations report handler failures; the supervisor logs them.
    async fn on_room_message(
        &self,
        _ctx: &PluginContext,
        _event: &OriginalSyncRoomMessageEvent,
        _spec: &PluginSpec,
        _meta: &RoomMessageMeta,
    ) -> Result<()> {
        Ok(())
    }
}

/// Command/mention triggers for a plugin.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct PluginTriggers {
    /// Commands, with or without the leading `!`.
    #[serde(default)]
    pub commands: Vec<String>,
    /// Mentions, with or without the leading `@`.
    #[serde(default)]
    pub mentions: Vec<String>,
}

/// A plugin's configuration entry: id, gating, triggers and free-form
/// plugin-specific config (flattened, so YAML keys sit at the same level).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PluginSpec {
    /// Which plugin this spec configures.
    pub id: String,
    /// Whether the plugin starts enabled.
    #[serde(default = "enabled_true")]
    pub enabled: bool,
    /// Override the plugin's own dev-only default.
    #[serde(default)]
    pub dev_only: Option<bool>,
    /// Commands/mentions that invoke the plugin.
    #[serde(default)]
    pub triggers: PluginTriggers,
    /// Free-form plugin-specific config.
    #[serde(default, flatten)]
    pub config: serde_yaml::Value,
}

const fn enabled_true() -> bool {
    true
}

/// A registered plugin plus its effective spec.
#[derive(Clone, Debug)]
pub struct PluginEntry {
    /// The effective (merged) spec.
    pub spec: PluginSpec,
    /// The plugin implementation.
    pub plugin: Arc<dyn Plugin + Send + Sync>,
}

#[derive(Default, Debug)]
struct RegistryInner {
    by_id: HashMap<String, PluginEntry>,
    by_command: HashMap<String, String>,
    by_mention: HashMap<String, String>,
    overrides: HashMap<String, bool>,
}

impl RegistryInner {
    fn remove_triggers_for(&mut self, id: &str) {
        self.by_command.retain(|_, existing| existing != id);
        self.by_mention.retain(|_, existing| existing != id);
        self.overrides.remove(id);
    }
}

/// Registry mapping plugin ids, commands and mentions to entries. Runtime
/// enable/disable overrides live here too (`!tools enable/disable`).
#[derive(Clone, Default, Debug)]
pub struct PluginRegistry {
    inner: Arc<RwLock<RegistryInner>>,
}

impl PluginRegistry {
    /// Create an empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, RegistryInner> {
        self.inner.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, RegistryInner> {
        self.inner.write().unwrap_or_else(PoisonError::into_inner)
    }

    /// Register `plugin` under `spec`, replacing any previous entry with the
    /// same id. Returns the replaced entry, if any.
    pub fn register(
        &self,
        spec: PluginSpec,
        plugin: Arc<dyn Plugin + Send + Sync>,
    ) -> Option<PluginEntry> {
        let mut inner = self.write();
        let id = spec.id.clone();
        let commands: Vec<String> = spec
            .triggers
            .commands
            .iter()
            .map(|c| normalize_cmd(c))
            .collect();
        let mentions: Vec<String> = spec
            .triggers
            .mentions
            .iter()
            .map(|m| normalize_mention(m))
            .collect();
        let previous = inner.by_id.insert(id.clone(), PluginEntry { spec, plugin });
        inner.remove_triggers_for(&id);
        for cmd in commands {
            inner.by_command.insert(cmd, id.clone());
        }
        for mention in mentions {
            inner.by_mention.insert(mention, id.clone());
        }
        previous
    }

    /// Remove the plugin with `id`, returning its entry if present.
    #[must_use = "the removed entry is returned; ignore explicitly if unneeded"]
    pub fn unregister(&self, id: &str) -> Option<PluginEntry> {
        let mut inner = self.write();
        let removed = inner.by_id.remove(id);
        inner.remove_triggers_for(id);
        removed
    }

    /// Entry by plugin id.
    #[must_use]
    pub fn entry(&self, id: &str) -> Option<PluginEntry> {
        self.read().by_id.get(id).cloned()
    }

    /// Entry by normalized command token (`!cmd`).
    #[must_use]
    pub fn entry_by_command(&self, token: &str) -> Option<PluginEntry> {
        let inner = self.read();
        inner
            .by_command
            .get(token)
            .and_then(|id| inner.by_id.get(id))
            .cloned()
    }

    /// Entry by normalized mention token (lowercase `@name`).
    #[must_use]
    pub fn entry_by_mention(&self, token: &str) -> Option<PluginEntry> {
        let inner = self.read();
        inner
            .by_mention
            .get(token)
            .and_then(|id| inner.by_id.get(id))
            .cloned()
    }

    /// All entries, unordered.
    #[must_use]
    pub fn entries(&self) -> Vec<(String, PluginEntry)> {
        self.read()
            .by_id
            .iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect()
    }

    /// Set a runtime enable/disable override for `id`.
    pub fn set_override(&self, id: impl Into<String>, enabled: bool) {
        self.write().overrides.insert(id.into(), enabled);
    }

    /// Clear a runtime override for `id`.
    pub fn clear_override(&self, id: &str) {
        self.write().overrides.remove(id);
    }

    /// Whether `id` is currently enabled (override beats spec default).
    #[must_use]
    pub fn is_enabled(&self, id: &str) -> bool {
        let inner = self.read();
        let default = inner.by_id.get(id).is_some_and(|entry| entry.spec.enabled);
        inner.overrides.get(id).copied().unwrap_or(default)
    }
}

/// Normalize a command trigger to `!cmd` form.
#[must_use]
pub fn normalize_cmd(s: &str) -> String {
    if s.starts_with('!') {
        s.to_owned()
    } else {
        format!("!{s}")
    }
}

/// Normalize a mention trigger to lowercase `@name` form.
#[must_use]
pub fn normalize_mention(s: &str) -> String {
    let raw = if s.starts_with('@') {
        s.to_owned()
    } else {
        format!("@{s}")
    };
    raw.to_lowercase()
}

/// Read a string value out of a spec's free-form config.
#[must_use]
pub fn str_config(spec: &PluginSpec, key: &str) -> Option<String> {
    spec.config
        .get(key)
        .and_then(|v| v.as_str())
        .map(std::borrow::ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Dummy;

    #[async_trait]
    impl Plugin for Dummy {
        fn id(&self) -> &'static str {
            "dummy"
        }
        fn help(&self) -> &'static str {
            "dummy"
        }
        fn spec(&self) -> PluginSpec {
            PluginSpec {
                id: "dummy".to_owned(),
                enabled: true,
                dev_only: None,
                triggers: PluginTriggers {
                    commands: vec!["dummy".to_owned()],
                    mentions: vec!["Dummy".to_owned()],
                },
                config: serde_yaml::Value::default(),
            }
        }
        async fn run(&self, _ctx: &PluginContext, _args: &str, _spec: &PluginSpec) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn registry_normalizes_triggers_and_resolves() {
        let registry = PluginRegistry::new();
        let plugin = Arc::new(Dummy);
        registry.register(plugin.spec(), plugin);

        assert!(registry.entry_by_command("!dummy").is_some());
        assert!(
            registry.entry_by_command("dummy").is_none(),
            "lookup key is normalized form"
        );
        assert!(registry.entry_by_mention("@dummy").is_some());
        assert!(registry.entry("dummy").is_some());
    }

    #[test]
    fn overrides_beat_spec_default_and_clear_restores() {
        let registry = PluginRegistry::new();
        let plugin = Arc::new(Dummy);
        registry.register(plugin.spec(), plugin);

        assert!(registry.is_enabled("dummy"));
        registry.set_override("dummy", false);
        assert!(!registry.is_enabled("dummy"));
        registry.clear_override("dummy");
        assert!(registry.is_enabled("dummy"));
    }

    #[test]
    fn unregister_removes_triggers() {
        let registry = PluginRegistry::new();
        let plugin = Arc::new(Dummy);
        registry.register(plugin.spec(), plugin);
        assert!(registry.unregister("dummy").is_some());
        assert!(registry.entry_by_command("!dummy").is_none());
        assert!(registry.entry_by_mention("@dummy").is_none());
    }

    #[test]
    fn spec_parses_flattened_config() {
        let yaml = r"
id: ai
provider: gemini
model: gemini-2.5-flash
pii_redaction: true
";
        let spec: PluginSpec = serde_yaml::from_str(yaml).expect("spec parses");
        assert_eq!(spec.id, "ai");
        assert!(spec.enabled);
        assert_eq!(str_config(&spec, "provider").as_deref(), Some("gemini"));
        assert_eq!(
            spec.config
                .get("pii_redaction")
                .and_then(serde_yaml::Value::as_bool),
            Some(true)
        );
    }
}
