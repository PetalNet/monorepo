use serde::{Deserialize, Serialize};

/// A serialized key package that can be uploaded to the server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializedKeyPackage {
    pub data: Vec<u8>,
}

/// A serialized MLS message (Welcome, Commit, or Application)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializedMlsMessage {
    pub data: Vec<u8>,
}

/// Result of creating a group — includes the initial commit
#[derive(Debug)]
pub struct CreateGroupResult {
    pub group_id: Vec<u8>,
    pub serialized_state: Vec<u8>,
}

/// Result of adding a member — Welcome for the new member, Commit for existing members
#[derive(Debug)]
pub struct AddMemberResult {
    pub welcome: Vec<u8>,
    pub commit: Vec<u8>,
}

/// Encrypted location payload
#[derive(Debug, Clone)]
pub struct EncryptedPayload {
    pub ciphertext: Vec<u8>,
    pub group_id: Vec<u8>,
}

/// Decrypted location data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationData {
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accuracy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    pub timestamp: i64,
}
