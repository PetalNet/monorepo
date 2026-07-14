//! Build the plugin registry from config + built-in defaults.

use std::{collections::HashMap, sync::Arc};

use tracing::{info, warn};

use courier_core::{
    config::{self, BotConfig, RoomCluster},
    health::RelayHealth,
    plugin::{Plugin, PluginRegistry, PluginSpec, PluginTriggers},
};
use courier_relay::{Relay, RelayCluster, RelayConfig};

/// Assemble the registry: built-in plugins, config-provided specs, the
/// injected relay spec (from `clusters`), and per-plugin config files.
pub fn build_registry(config: &BotConfig, health: &Arc<RelayHealth>) -> Arc<PluginRegistry> {
    // Plugin id -> instance. Plugins are stateless or internally
    // synchronized; one instance serves everything.
    #[rustfmt::skip]
    let plugins: HashMap<&'static str, Arc<dyn Plugin + Send + Sync>> = HashMap::from([
        ("ping", Arc::new(courier_plugins::Ping) as Arc<dyn Plugin + Send + Sync>),
        ("mode", Arc::new(courier_plugins::ModeTool) as Arc<dyn Plugin + Send + Sync>),
        ("diag", Arc::new(courier_plugins::DiagTool::new(Arc::clone(health))) as Arc<dyn Plugin + Send + Sync>),
        ("tools", Arc::new(courier_plugins::ToolsManager) as Arc<dyn Plugin + Send + Sync>),
        ("ai", Arc::new(courier_ai::AiTool) as Arc<dyn Plugin + Send + Sync>),
        ("echo", Arc::new(courier_plugins::EchoTool) as Arc<dyn Plugin + Send + Sync>),
        ("relay", Arc::new(Relay::new(Arc::clone(health))) as Arc<dyn Plugin + Send + Sync>),
    ]);

    let mut specs = config.plugins.clone().unwrap_or_default();

    // Inject relay plugin configuration if clusters are defined and no
    // explicit spec exists.
    info!(
        clusters_count = config.clusters.len(),
        "Checking relay config"
    );
    if !specs.iter().any(|s| s.id == "relay") && !config.clusters.is_empty() {
        let relay_config = RelayConfig {
            clusters: config.clusters.iter().map(cluster_from_bot).collect(),
            reupload_media: config.reupload_media,
            caption_media: config.caption_media,
            backfill_limit: config.backfill_limit,
        };
        info!(
            relay_clusters = relay_config.clusters.len(),
            "Creating relay spec"
        );
        let config_value = serde_yaml::to_value(relay_config).unwrap_or_default();
        specs.push(PluginSpec {
            id: "relay".to_owned(),
            enabled: true,
            dev_only: None,
            triggers: PluginTriggers::default(),
            config: config_value,
        });
        info!("Relay plugin spec added to registry");
    } else if config.clusters.is_empty() {
        info!("No clusters defined - relay will not be registered");
    }

    // Merge defaults from each plugin implementation, without duplicating
    // ids.
    for p in plugins.values() {
        config::merge_default_spec(&mut specs, p.spec());
    }

    let registry = Arc::new(PluginRegistry::new());
    let default_dir = if std::path::Path::new("./plugins").exists() {
        "./plugins".to_owned()
    } else {
        "./tools".to_owned()
    };
    let plugins_dir = std::env::var("PLUGINS_DIR")
        .or_else(|_| std::env::var("TOOLS_DIR"))
        .unwrap_or(default_dir);

    for mut spec in specs {
        let Some(plugin) = plugins.get(spec.id.as_str()) else {
            warn!("Unknown plugin ID: {}", spec.id);
            continue;
        };
        if let Some(file_cfg) = config::load_plugin_config(&plugins_dir, spec.id.as_str()) {
            spec.config = config::merge_yaml(file_cfg, spec.config);
        }
        registry.register(spec, Arc::clone(plugin));
    }

    registry
}

fn cluster_from_bot(cluster: &RoomCluster) -> RelayCluster {
    RelayCluster {
        rooms: cluster.rooms.clone(),
        reupload_media: cluster.reupload_media,
        caption_media: cluster.caption_media,
        backfill_limit: cluster.backfill_limit,
    }
}
