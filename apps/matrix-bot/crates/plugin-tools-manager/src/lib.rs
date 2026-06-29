use anyhow::Result;
use async_trait::async_trait;

use plugin_core::{Plugin, PluginContext, PluginRegistry, PluginSpec, PluginTriggers, send_text};

#[derive(Debug)]
pub struct ToolsManagerPlugin;

#[derive(Debug)]
pub struct ToolsManager;

#[async_trait]
impl Plugin for ToolsManager {
    fn id(&self) -> &'static str {
        "tools"
    }
    fn help(&self) -> &'static str {
        "Manage plugins: !tools list | enable <id> | disable <id>"
    }
    fn spec(&self) -> PluginSpec {
        PluginSpec {
            id: "tools".to_owned(),
            enabled: true,
            dev_only: None,
            triggers: PluginTriggers {
                commands: vec!["!tools".to_owned(), "!plugins".to_owned()],
                mentions: vec![],
            },
            config: serde_yaml::Value::default(),
        }
    }
    async fn run(&self, ctx: &PluginContext, args: &str, _spec: &PluginSpec) -> Result<()> {
        let registry: &PluginRegistry = &ctx.registry;
        let mut parts = args.split_whitespace();
        match parts.next() {
            Some("list") | None => {
                let mut rows = vec!["plugins:".to_owned()];
                for (id, entry) in registry.entries().await {
                    let enabled = registry.is_enabled(&id).await;
                    #[allow(clippy::or_fun_call, reason = "const fn")]
                    let dev_only = entry.spec.dev_only.unwrap_or(entry.plugin.dev_only());
                    let triggers = format!(
                        "cmds=[{}], mentions=[{}]",
                        entry.spec.triggers.commands.join(", "),
                        entry.spec.triggers.mentions.join(", ")
                    );
                    rows.push(format!(
                        "- {id}: enabled={enabled} dev_only={dev_only} {triggers}",
                    ));
                }
                send_text(ctx, rows.join("\n")).await
            }
            Some("enable") => {
                if let Some(id) = parts.next() {
                    registry.set_override(id, true).await;
                    send_text(ctx, format!("enabled plugin: {id}")).await
                } else {
                    send_text(ctx, "Usage: !tools enable <id> (alias: !plugins)").await
                }
            }
            Some("disable") => {
                if let Some(id) = parts.next() {
                    registry.set_override(id, false).await;
                    send_text(ctx, format!("disabled plugin: {id}")).await
                } else {
                    send_text(ctx, "Usage: !tools disable <id> (alias: !plugins)").await
                }
            }
            _ => {
                send_text(
                    ctx,
                    "Usage: !tools [list|enable <id>|disable <id>] (alias: !plugins)",
                )
                .await
            }
        }
    }
}
