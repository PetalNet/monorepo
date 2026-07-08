//! `!ping` → "pong". Also answers when `!ping` appears mid-message.

use anyhow::Result;
use async_trait::async_trait;
use matrix_sdk::ruma::events::room::message::OriginalSyncRoomMessageEvent;

use courier_core::{
    plugin::{Plugin, PluginContext, PluginSpec, PluginTriggers, RoomMessageMeta},
    send::send_text,
};

/// The ping plugin.
#[derive(Debug)]
pub struct Ping;

#[async_trait]
impl Plugin for Ping {
    fn id(&self) -> &'static str {
        "ping"
    }
    fn help(&self) -> &'static str {
        "🏓"
    }
    fn spec(&self) -> PluginSpec {
        PluginSpec {
            id: "ping".to_owned(),
            enabled: true,
            dev_only: None,
            triggers: PluginTriggers {
                commands: vec!["!ping".to_owned()],
                mentions: vec![],
            },
            config: serde_yaml::Value::default(),
        }
    }

    fn handles_room_messages(&self) -> bool {
        true
    }

    fn wants_own_messages(&self) -> bool {
        true
    }

    async fn run(&self, ctx: &PluginContext, _args: &str, _spec: &PluginSpec) -> Result<()> {
        send_text(ctx, "pong".to_owned()).await
    }

    async fn on_room_message(
        &self,
        ctx: &PluginContext,
        _event: &OriginalSyncRoomMessageEvent,
        _spec: &PluginSpec,
        meta: &RoomMessageMeta,
    ) -> Result<()> {
        if meta.triggered_plugins.contains(self.id()) {
            return Ok(());
        }
        if meta
            .body
            .as_deref()
            .is_some_and(|body| body.contains("!ping"))
        {
            send_text(ctx, "pong".to_owned()).await?;
        }
        Ok(())
    }
}
