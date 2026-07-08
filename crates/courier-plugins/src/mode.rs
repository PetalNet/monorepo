//! `!mode` — show the current dev/prod mode and how to target it.

use anyhow::Result;
use async_trait::async_trait;

use courier_core::{
    plugin::{Plugin, PluginContext, PluginSpec, PluginTriggers},
    send::send_text,
};

/// The mode plugin.
#[derive(Debug)]
pub struct ModeTool;

#[async_trait]
impl Plugin for ModeTool {
    fn id(&self) -> &'static str {
        "mode"
    }
    fn help(&self) -> &'static str {
        "Show current mode (dev/prod) and how to target it."
    }
    fn spec(&self) -> PluginSpec {
        PluginSpec {
            id: "mode".to_owned(),
            enabled: true,
            dev_only: None,
            triggers: PluginTriggers {
                commands: vec!["!mode".to_owned()],
                mentions: vec![],
            },
            config: serde_yaml::Value::default(),
        }
    }
    async fn run(&self, ctx: &PluginContext, _args: &str, _spec: &PluginSpec) -> Result<()> {
        let mode = if ctx.dev_active { "dev" } else { "prod" };
        let mut lines = vec![format!("mode: {mode}")];
        if ctx.dev_active {
            if let Some(dev_id) = ctx.dev_id.as_deref() {
                lines.push(format!(
                    "this instance handles commands tagged as !{dev_id}.<command>"
                ));
                lines.push(format!("example: !{dev_id}.diag"));
                lines.push(format!("mentions must use @{dev_id}.<name>"));
            } else {
                lines.push("this instance handles commands routed to dev".to_owned());
                lines.push("example: !devid.diag".to_owned());
            }
        } else {
            if let Some(dev_id) = ctx.dev_id.as_deref() {
                lines.push(format!("commands without !{dev_id}. prefix run here"));
                lines.push(format!(
                    "commands containing !{dev_id}.<command> are ignored"
                ));
            } else {
                lines.push("this instance handles commands without a dev prefix".to_owned());
            }
            lines.push("example: !diag".to_owned());
        }
        send_text(ctx, lines.join("\n")).await
    }
}
