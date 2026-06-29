use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RelayConfig {
    #[serde(default)]
    pub clusters: Vec<RelayCluster>,
    #[serde(default)]
    pub reupload_media: Option<bool>,
    #[serde(default)]
    pub caption_media: Option<bool>,
    #[serde(default)]
    pub backfill_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RelayCluster {
    #[serde(default)]
    pub rooms: Vec<String>,
    #[serde(default)]
    pub reupload_media: Option<bool>,
    #[serde(default)]
    pub caption_media: Option<bool>,
    #[serde(default)]
    pub backfill_limit: Option<usize>,
}
