//! Relay configuration and the resolved relay plan.

use std::collections::HashMap;

use anyhow::Result;
use matrix_sdk::{
    Client,
    ruma::{OwnedRoomId, RoomAliasId, RoomId},
};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use courier_core::bound;

pub const DEFAULT_BACKFILL_LIMIT: usize = 12;
pub const MAX_BACKFILL_LIMIT: usize = 25;
pub const LOOKUP_TIMEOUT: core::time::Duration = core::time::Duration::from_secs(15);

/// Relay plugin configuration (mirrors the top-level `clusters` schema).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RelayConfig {
    /// Clusters of rooms that relay to each other.
    #[serde(default)]
    pub clusters: Vec<RelayCluster>,
    /// Global default for media re-upload.
    #[serde(default)]
    pub reupload_media: Option<bool>,
    /// Global default for media captions.
    #[serde(default)]
    pub caption_media: Option<bool>,
    /// Global default startup backfill limit.
    #[serde(default)]
    pub backfill_limit: Option<usize>,
}

/// One cluster of rooms.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RelayCluster {
    /// Room IDs or aliases.
    #[serde(default)]
    pub rooms: Vec<String>,
    /// Per-cluster override.
    #[serde(default)]
    pub reupload_media: Option<bool>,
    /// Per-cluster override.
    #[serde(default)]
    pub caption_media: Option<bool>,
    /// Per-cluster override.
    #[serde(default)]
    pub backfill_limit: Option<usize>,
}

/// Effective per-source-room relay options.
#[derive(Debug, Clone, Copy)]
pub struct RelayOptions {
    pub reupload_media: bool,
    pub caption_media: bool,
    pub backfill_limit: usize,
}

impl Default for RelayOptions {
    fn default() -> Self {
        Self {
            reupload_media: true,
            caption_media: true,
            backfill_limit: DEFAULT_BACKFILL_LIMIT,
        }
    }
}

/// The resolved relay plan: source room → target rooms, plus options.
#[derive(Debug, Clone, Default)]
pub struct RelayPlan {
    pub map: HashMap<OwnedRoomId, Vec<OwnedRoomId>>,
    pub opts: HashMap<OwnedRoomId, RelayOptions>,
}

pub fn clamp_backfill_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_BACKFILL_LIMIT)
        .min(MAX_BACKFILL_LIMIT)
}

/// Resolve cluster room references (ids and aliases) into the relay plan.
/// Alias resolution hits the network, so it is bounded; unresolvable
/// references are skipped loudly.
pub async fn resolve_relay_map(client: &Client, cfg: &RelayConfig) -> Result<RelayPlan> {
    let mut map: HashMap<OwnedRoomId, Vec<OwnedRoomId>> = HashMap::new();
    let mut opts: HashMap<OwnedRoomId, RelayOptions> = HashMap::new();

    for cluster in &cfg.clusters {
        let mut resolved: Vec<OwnedRoomId> = Vec::new();
        for room_ref in &cluster.rooms {
            if let Ok(id) = RoomId::parse(room_ref) {
                resolved.push(id.clone());
                continue;
            }
            if room_ref.starts_with('#') {
                if let Ok(alias) = RoomAliasId::parse(room_ref) {
                    match bound::bounded(
                        "relay.resolve_alias",
                        LOOKUP_TIMEOUT,
                        client.resolve_room_alias(&alias),
                    )
                    .await
                    {
                        Ok(resp) => {
                            resolved.push(resp.room_id.clone());
                        }
                        Err(e) => {
                            warn!(alias = %room_ref, error = %e, "Failed to resolve room alias; skipping");
                        }
                    }
                } else {
                    warn!(alias = %room_ref, "Invalid room alias; skipping");
                }
            } else {
                warn!(room = %room_ref, "Invalid room reference (expect !room_id or #alias); skipping");
            }
        }

        let effective = RelayOptions {
            reupload_media: cluster
                .reupload_media
                .or(cfg.reupload_media)
                .unwrap_or(true),
            caption_media: cluster.caption_media.or(cfg.caption_media).unwrap_or(true),
            backfill_limit: clamp_backfill_limit(cluster.backfill_limit.or(cfg.backfill_limit)),
        };

        for r in &resolved {
            let peers: Vec<OwnedRoomId> = resolved.iter().filter(|x| *x != r).cloned().collect();
            map.entry(r.clone())
                .and_modify(|existing| {
                    for p in &peers {
                        if !existing.contains(p) {
                            existing.push(p.clone());
                        }
                    }
                })
                .or_insert(peers);
            opts.insert(r.clone(), effective);
        }
    }

    info!(
        clusters = cfg.clusters.len(),
        rooms = map.len(),
        "Loaded relay mapping"
    );
    for (from, peers) in &map {
        let peer_list = peers
            .iter()
            .map(|p| p.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        info!(from = %from, peers = %peer_list, "Relay mapping entry");
    }

    Ok(RelayPlan { map, opts })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backfill_limit_is_clamped() {
        assert_eq!(clamp_backfill_limit(None), DEFAULT_BACKFILL_LIMIT);
        assert_eq!(clamp_backfill_limit(Some(5)), 5);
        assert_eq!(clamp_backfill_limit(Some(999)), MAX_BACKFILL_LIMIT);
    }

    #[test]
    fn relay_config_parses_cluster_shape() {
        let yaml = r#"
clusters:
  - rooms: ["!a:hs", "!b:hs"]
    caption_media: false
reupload_media: true
"#;
        let cfg: RelayConfig = serde_yaml::from_str(yaml).expect("relay config parses");
        assert_eq!(cfg.clusters.len(), 1);
        assert_eq!(cfg.clusters[0].caption_media, Some(false));
        assert_eq!(cfg.reupload_media, Some(true));
    }
}
