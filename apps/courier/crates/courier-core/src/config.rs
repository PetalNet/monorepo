//! YAML config schema and merge helpers.
//!
//! The schema is wire-compatible with the previous generation's
//! `config.yaml`: room clusters (with per-cluster media/backfill overrides),
//! global defaults, dev-mode gating, and a `plugins:` list (legacy alias
//! `tools:`) of [`PluginSpec`]s with flattened plugin-specific config.

use std::fs;
use std::path::Path;

use anyhow::{Context as _, Result, anyhow};
use serde::Deserialize;

use crate::plugin::PluginSpec;

/// Top-level bot configuration.
#[derive(Debug, Deserialize, Clone)]
pub struct BotConfig {
    /// Room clusters to relay between.
    pub clusters: Vec<RoomCluster>,
    /// Global default: re-upload media instead of forwarding `mxc:` URIs.
    #[serde(default)]
    pub reupload_media: Option<bool>,
    /// Global default: send a "Name: sent an image" caption after media.
    #[serde(default)]
    pub caption_media: Option<bool>,
    /// Global default: startup backfill limit per source room.
    #[serde(default)]
    pub backfill_limit: Option<usize>,
    /// Whether dev-mode gating may be enabled on this instance.
    #[serde(default)]
    pub dev_mode: Option<bool>,
    /// Identifier used by `!devid.command` / `@devid.mention` routing.
    #[serde(default)]
    pub dev_id: Option<String>,
    /// Plugin specs (legacy alias: `tools`).
    #[serde(default, alias = "tools")]
    pub plugins: Option<Vec<PluginSpec>>,
}

/// One cluster of rooms that relay to each other.
#[derive(Debug, Deserialize, Clone)]
pub struct RoomCluster {
    /// Room IDs (`!room:server`) or aliases (`#alias:server`).
    pub rooms: Vec<String>,
    /// Per-cluster override of the global `reupload_media`.
    #[serde(default)]
    pub reupload_media: Option<bool>,
    /// Per-cluster override of the global `caption_media`.
    #[serde(default)]
    pub caption_media: Option<bool>,
    /// Per-cluster override of the global `backfill_limit`.
    #[serde(default)]
    pub backfill_limit: Option<usize>,
}

/// Load and parse the YAML config at `path`.
///
/// # Errors
///
/// Returns an error when the file is missing, unreadable, or not valid YAML
/// for the schema.
pub fn load_config(path: &Path) -> Result<BotConfig> {
    if !path.exists() {
        return Err(anyhow!(
            "config file not found at {}. Create one or set --config",
            path.display()
        ));
    }
    let yaml = fs::read_to_string(path)
        .with_context(|| format!("reading config file at {}", path.display()))?;
    let cfg: BotConfig = serde_yaml::from_str(&yaml).context("parsing YAML config")?;
    Ok(cfg)
}

/// Deep-merge two YAML values; `a` (file config) wins over `b` (spec config)
/// for scalar conflicts, mappings merge recursively, sequences concatenate.
#[must_use]
pub fn merge_yaml(file_cfg: serde_yaml::Value, spec_cfg: serde_yaml::Value) -> serde_yaml::Value {
    use serde_yaml::Value::{Mapping, Sequence};
    match (file_cfg, spec_cfg) {
        (Mapping(mut a), Mapping(b)) => {
            for (k, v_b) in b {
                match a.get_mut(&k) {
                    Some(v_a) => {
                        let merged = merge_yaml(v_a.clone(), v_b);
                        *v_a = merged;
                    }
                    None => {
                        a.insert(k, v_b);
                    }
                }
            }
            Mapping(a)
        }
        (Sequence(mut a), Sequence(b)) => {
            a.extend(b);
            Sequence(a)
        }
        (a, _b) => a,
    }
}

/// Merge a plugin's default spec into `specs` without duplicating ids:
/// missing triggers are added; user-provided `config`/`enabled`/`dev_only`
/// win.
pub fn merge_default_spec(specs: &mut Vec<PluginSpec>, default: PluginSpec) {
    if let Some(existing) = specs.iter_mut().find(|s| s.id == default.id) {
        for cmd in default.triggers.commands {
            if !existing
                .triggers
                .commands
                .iter()
                .any(|c| c.eq_ignore_ascii_case(&cmd))
            {
                existing.triggers.commands.push(cmd);
            }
        }
        for mention in default.triggers.mentions {
            if !existing
                .triggers
                .mentions
                .iter()
                .any(|m| m.eq_ignore_ascii_case(&mention))
            {
                existing.triggers.mentions.push(mention);
            }
        }
        // Existing config/enabled/dev_only are user- or file-provided; keep.
    } else {
        specs.push(default);
    }
}

/// Load `<root>/<id>/config.yaml` if present (per-plugin config files).
#[must_use]
pub fn load_plugin_config(root: &str, id: &str) -> Option<serde_yaml::Value> {
    let root = root.trim_end_matches('/');
    let path = format!("{root}/{id}/config.yaml");
    match std::fs::read_to_string(&path) {
        Ok(s) => match serde_yaml::from_str::<serde_yaml::Value>(&s) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::warn!(plugin = %id, file = %path, error = %e, "Failed to parse plugin config YAML");
                None
            }
        },
        Err(e) => {
            if Path::new(&path).exists() {
                tracing::warn!(plugin = %id, file = %path, error = %e, "Failed to read plugin config file");
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_schema_matches_production_layout() {
        // Mirrors the production config: clusters with room ids + plugins.
        let yaml = r#"
clusters:
  - name: cluster
    rooms:
      - "!aaaaaaaaaaaaaaaaaaaa:beeper.local"
      - "!bbbbbbbbbbbbbbbbbbbb:beeper.local"
    backfill_limit: 10

plugins:
  - id: ai
    provider: "gemini"
    model: "gemini-2.5-flash"
    pii_redaction: true
"#;
        let cfg: BotConfig = serde_yaml::from_str(yaml).expect("production-shaped config parses");
        assert_eq!(cfg.clusters.len(), 1);
        assert_eq!(cfg.clusters[0].rooms.len(), 2);
        assert_eq!(cfg.clusters[0].backfill_limit, Some(10));
        let plugins = cfg.plugins.expect("plugins parsed");
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "ai");
    }

    #[test]
    fn config_accepts_legacy_tools_alias_and_global_options() {
        let yaml = r#"
reupload_media: true
caption_media: false
dev_mode: true
dev_id: claire
clusters:
  - rooms: ["!x:hs", "!y:hs"]
tools:
  - id: echo
"#;
        let cfg: BotConfig = serde_yaml::from_str(yaml).expect("legacy config parses");
        assert_eq!(cfg.reupload_media, Some(true));
        assert_eq!(cfg.caption_media, Some(false));
        assert_eq!(cfg.dev_mode, Some(true));
        assert_eq!(cfg.dev_id.as_deref(), Some("claire"));
        assert_eq!(cfg.plugins.expect("tools alias").len(), 1);
    }

    #[test]
    fn config_accepts_dashed_mcp_servers_key() {
        // The production file spells it `mcp-servers`; the flattened spec
        // config must carry it through for the AI plugin to find.
        let yaml = r#"
clusters:
  - rooms: ["!x:hs", "!y:hs"]
plugins:
  - id: ai
    mcp-servers:
      websearch:
        command: npx
        args: ["-y", "@guhcostan/web-search-mcp"]
"#;
        let cfg: BotConfig = serde_yaml::from_str(yaml).expect("config parses");
        let plugins = cfg.plugins.expect("plugins parsed");
        assert!(plugins[0].config.get("mcp-servers").is_some());
    }

    #[test]
    fn merge_yaml_file_wins_and_maps_merge() {
        let file: serde_yaml::Value = serde_yaml::from_str("a: 1\nnested:\n  x: file").unwrap();
        let spec: serde_yaml::Value =
            serde_yaml::from_str("a: 2\nb: 3\nnested:\n  x: spec\n  y: keep").unwrap();
        let merged = merge_yaml(file, spec);
        assert_eq!(merged.get("a").and_then(serde_yaml::Value::as_i64), Some(1));
        assert_eq!(merged.get("b").and_then(serde_yaml::Value::as_i64), Some(3));
        let nested = merged.get("nested").expect("nested");
        assert_eq!(
            nested.get("x").and_then(serde_yaml::Value::as_str),
            Some("file")
        );
        assert_eq!(
            nested.get("y").and_then(serde_yaml::Value::as_str),
            Some("keep")
        );
    }

    #[test]
    fn merge_default_spec_adds_missing_triggers_only() {
        use crate::plugin::{PluginSpec, PluginTriggers};
        let mut specs = vec![PluginSpec {
            id: "ai".to_owned(),
            enabled: false,
            dev_only: None,
            triggers: PluginTriggers {
                commands: vec!["!ai".to_owned()],
                mentions: vec![],
            },
            config: serde_yaml::Value::default(),
        }];
        let default = PluginSpec {
            id: "ai".to_owned(),
            enabled: true,
            dev_only: None,
            triggers: PluginTriggers {
                commands: vec!["!ai".to_owned()],
                mentions: vec!["@claire".to_owned()],
            },
            config: serde_yaml::Value::default(),
        };
        merge_default_spec(&mut specs, default);
        assert_eq!(specs.len(), 1);
        assert!(!specs[0].enabled, "user-provided enabled wins");
        assert_eq!(specs[0].triggers.commands.len(), 1, "no duplicate command");
        assert_eq!(specs[0].triggers.mentions, vec!["@claire".to_owned()]);
    }
}
