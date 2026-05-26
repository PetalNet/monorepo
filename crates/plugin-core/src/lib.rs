use core::fmt::Debug;
use std::{
    borrow::ToOwned,
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};

use anyhow::Result;
use async_trait::async_trait;
use matrix_sdk::{
    Client,
    room::Room,
    ruma::events::room::message::{OriginalSyncRoomMessageEvent, RoomMessageEventContent},
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

#[derive(Clone, Debug)]
pub struct PluginContext {
    pub client: Client,
    pub room: Room,
    pub dev_active: bool,
    pub dev_id: Option<Arc<str>>,
    pub registry: Arc<PluginRegistry>,
    pub history_dir: Arc<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct RoomMessageMeta {
    pub body: Option<String>,
    pub triggered_plugins: Arc<HashSet<String>>,
}

#[async_trait]
pub trait Plugin: Send + Sync + Debug {
    fn id(&self) -> &'static str;
    fn help(&self) -> &'static str;
    /// Return this plugin's default specifications to be merged at startup.
    fn spec(&self) -> PluginSpec;

    fn dev_only(&self) -> bool {
        false
    }
    fn handles_room_messages(&self) -> bool {
        false
    }
    fn wants_own_messages(&self) -> bool {
        false
    }
    async fn run(&self, ctx: &PluginContext, args: &str, spec: &PluginSpec) -> Result<()>;

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

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct PluginTriggers {
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub mentions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PluginSpec {
    pub id: String,
    #[serde(default = "enabled_true")]
    pub enabled: bool,
    #[serde(default)]
    pub dev_only: Option<bool>,
    #[serde(default)]
    pub triggers: PluginTriggers,
    #[serde(default, flatten)]
    pub config: serde_yaml::Value,
}

const fn enabled_true() -> bool {
    true
}

#[derive(Clone, Debug)]
pub struct PluginEntry {
    pub spec: PluginSpec,
    pub plugin: Arc<dyn Plugin + Send + Sync>,
}

#[derive(Default, Debug)]
struct RegistryInner {
    by_id: HashMap<String, PluginEntry>,
    by_command: HashMap<String, String>,
    by_mention: HashMap<String, String>,
    overrides: HashMap<String, bool>,
}

#[derive(Clone, Default, Debug)]
pub struct PluginRegistry {
    inner: Arc<RwLock<RegistryInner>>,
}

impl PluginRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(
        &self,
        spec: PluginSpec,
        plugin: Arc<dyn Plugin + Send + Sync>,
    ) -> Option<PluginEntry> {
        let mut inner = self.inner.write().await;
        let id = spec.id.clone();
        let previous = inner.by_id.insert(
            id.clone(),
            PluginEntry {
                spec: spec.clone(),
                plugin,
            },
        );
        inner.remove_triggers_for(&id);
        for cmd in &spec.triggers.commands {
            inner.by_command.insert(normalize_cmd(cmd), id.clone());
        }
        for mention in &spec.triggers.mentions {
            inner
                .by_mention
                .insert(normalize_mention(mention), id.clone());
        }
        previous
    }

    pub async fn unregister(&self, id: &str) -> Option<PluginEntry> {
        let mut inner = self.inner.write().await;
        let removed = inner.by_id.remove(id);
        inner.remove_triggers_for(id);
        removed
    }

    pub async fn entry(&self, id: &str) -> Option<PluginEntry> {
        let inner = self.inner.read().await;
        inner.by_id.get(id).cloned()
    }

    pub async fn entry_by_command(&self, token: &str) -> Option<PluginEntry> {
        let inner = self.inner.read().await;
        inner
            .by_command
            .get(token)
            .and_then(|id| inner.by_id.get(id))
            .cloned()
    }

    pub async fn entry_by_mention(&self, token: &str) -> Option<PluginEntry> {
        let inner = self.inner.read().await;
        inner
            .by_mention
            .get(token)
            .and_then(|id| inner.by_id.get(id))
            .cloned()
    }

    pub async fn entries(&self) -> Vec<(String, PluginEntry)> {
        let inner = self.inner.read().await;
        inner
            .by_id
            .iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect()
    }

    pub async fn set_override(&self, id: impl Into<String>, enabled: bool) {
        let mut inner = self.inner.write().await;
        inner.overrides.insert(id.into(), enabled);
    }

    pub async fn clear_override(&self, id: &str) {
        let mut inner = self.inner.write().await;
        inner.overrides.remove(id);
    }

    #[must_use]
    pub async fn is_enabled(&self, id: &str) -> bool {
        let inner = self.inner.read().await;
        let default = inner.by_id.get(id).is_some_and(|entry| entry.spec.enabled);
        inner.overrides.get(id).copied().unwrap_or(default)
    }
}

impl RegistryInner {
    fn remove_triggers_for(&mut self, id: &str) {
        self.by_command.retain(|_, existing| existing != id);
        self.by_mention.retain(|_, existing| existing != id);
        self.overrides.remove(id);
    }
}

fn normalize_cmd(s: &str) -> String {
    if s.starts_with('!') {
        s.to_owned()
    } else {
        format!("!{s}")
    }
}

fn normalize_mention(s: &str) -> String {
    let raw = if s.starts_with('@') {
        s.to_owned()
    } else {
        format!("@{s}")
    };
    raw.to_lowercase()
}

pub fn str_config(spec: &PluginSpec, key: &str) -> Option<String> {
    spec.config
        .get(key)
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned)
}

#[must_use]
pub fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[must_use]
fn decorate_dev(text: &str, dev_active: bool) -> String {
    if dev_active {
        format!("=======DEV MODE=======\n{text}")
    } else {
        text.to_owned()
    }
}

/// Send a plain-text message to the current room.
///
/// The message text will be decorated with a development mode banner when
/// `PluginContext.dev_active` is true.
///
/// # Errors
///
/// Returns an error if sending the message fails. The underlying error is
/// propagated from the matrix-sdk send operation.
pub async fn send_text(ctx: &PluginContext, text: impl Into<String>) -> Result<()> {
    let text = text.into();
    let content = RoomMessageEventContent::text_plain(decorate_dev(&text, ctx.dev_active));
    ctx.room.send(content).await?;
    Ok(())
}

#[must_use]
pub fn sanitize_line(s: &str, max: usize) -> String {
    let compact = s.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&compact, max)
}
