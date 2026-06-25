use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;

use plugin_core::{Plugin, PluginContext, PluginSpec, PluginTriggers, send_text};

#[derive(Debug)]
pub struct EchoPlugin;

#[derive(Debug)]
pub struct EchoTool;

#[derive(Debug, Clone, Deserialize, Default)]
struct EchoConfig {
    #[serde(default)]
    prefix: Option<String>,
    #[serde(default)]
    uppercase: bool,
}

#[async_trait]
impl Plugin for EchoTool {
    fn id(&self) -> &'static str {
        "echo"
    }
    fn help(&self) -> &'static str {
        "Echo text back. Config: prefix, uppercase"
    }
    fn spec(&self) -> PluginSpec {
        PluginSpec {
            id: "echo".into(),
            enabled: true,
            dev_only: None,
            triggers: PluginTriggers {
                commands: vec!["!echo".into()],
                mentions: vec![],
            },
            config: serde_yaml::Value::default(),
        }
    }
    async fn run(&self, ctx: &PluginContext, args: &str, spec: &PluginSpec) -> Result<()> {
        let cfg: EchoConfig = serde_yaml::from_value(spec.config.clone()).unwrap_or_default();
        let mut out = args.trim().to_owned();
        if cfg.uppercase {
            out = out.to_uppercase();
        }
        if let Some(p) = cfg.prefix {
            format!("{p}{out}").clone_into(&mut out);
        }
        if out.is_empty() {
            "(nothing to echo)".clone_into(&mut out);
        }
        send_text(ctx, out).await
    }
}
