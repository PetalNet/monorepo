//! MLS cryptographic operations for Point.

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::{MemoryStorage, RustCrypto};
use openmls_traits::OpenMlsProvider;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

use crate::errors::{PointCryptoError, Result};
use crate::types::*;

// X25519 + ChaCha20Poly1305 + Ed25519 — strong classical security
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

// ---------------------------------------------------------------------------
// PointProvider — OpenMlsProvider with accessible mutable storage
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct PointProvider {
    crypto: RustCrypto,
    storage: MemoryStorage,
}

impl OpenMlsProvider for PointProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &MemoryStorage {
        &self.storage
    }
    fn crypto(&self) -> &RustCrypto {
        &self.crypto
    }
    fn rand(&self) -> &RustCrypto {
        &self.crypto
    }
}

impl PointProvider {
    /// Serialize the full MLS storage to bytes so the caller can persist them.
    pub fn export_storage(&self) -> Result<Vec<u8>> {
        use std::io::{Read, Seek, SeekFrom};
        let tmp = tempfile::tempfile()
            .map_err(|e| PointCryptoError::Mls(format!("tempfile create: {e}")))?;
        self.storage
            .save_to_file(&tmp)
            .map_err(|e| PointCryptoError::Mls(format!("storage save: {e}")))?;
        let mut tmp = tmp;
        tmp.seek(SeekFrom::Start(0))
            .map_err(|e| PointCryptoError::Mls(format!("tempfile seek: {e}")))?;
        let mut bytes = Vec::new();
        tmp.read_to_end(&mut bytes)
            .map_err(|e| PointCryptoError::Mls(format!("tempfile read: {e}")))?;
        Ok(bytes)
    }

    /// Restore storage from previously exported bytes.
    pub fn import_storage(&mut self, bytes: &[u8]) -> Result<()> {
        use std::io::{Seek, SeekFrom, Write};
        let mut tmp = tempfile::tempfile()
            .map_err(|e| PointCryptoError::Mls(format!("tempfile create: {e}")))?;
        tmp.write_all(bytes)
            .map_err(|e| PointCryptoError::Mls(format!("tempfile write: {e}")))?;
        tmp.seek(SeekFrom::Start(0))
            .map_err(|e| PointCryptoError::Mls(format!("tempfile seek: {e}")))?;
        self.storage
            .load_from_file(&tmp)
            .map_err(|e| PointCryptoError::Mls(format!("storage load: {e}")))
    }
}

// ---------------------------------------------------------------------------
// Serializable state envelope
// ---------------------------------------------------------------------------

/// Everything needed to fully restore a PointCrypto instance.
/// Stored by the caller (Dart layer) in platform secure storage.
#[derive(Serialize, Deserialize)]
pub struct PointCryptoState {
    pub identity: String,
    /// Serialized MemoryStorage (JSON produced by MemoryStorage::save_to_file).
    pub storage_json: Vec<u8>,
    /// Hex-encoded group IDs so we know which groups to reload from storage.
    pub group_ids: Vec<String>,
    /// Hex-encoded signer public key — needed to look up the signer in storage.
    pub signer_public_key: String,
}

// ---------------------------------------------------------------------------
// PointCrypto
// ---------------------------------------------------------------------------

pub struct PointCrypto {
    provider: PointProvider,
    credential: CredentialWithKey,
    signer: SignatureKeyPair,
    groups: HashMap<Vec<u8>, MlsGroup>,
    identity: String,
}

impl PointCrypto {
    /// Create a fresh instance — generates a new signing key and empty state.
    pub fn new(identity: &str) -> Result<Self> {
        let provider = PointProvider::default();

        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(|e| PointCryptoError::Mls(format!("{e:?}")))?;
        signer
            .store(provider.storage())
            .map_err(|e| PointCryptoError::Mls(format!("{e:?}")))?;

        let credential = BasicCredential::new(identity.as_bytes().to_vec());
        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: signer.to_public_vec().into(),
        };

        Ok(Self {
            provider,
            credential: credential_with_key,
            signer,
            groups: HashMap::new(),
            identity: identity.to_string(),
        })
    }

    /// Restore from a previously exported state blob. Returns Err if the blob
    /// is invalid; callers should fall back to `new()` on error and re-establish
    /// group memberships via the normal Welcome/Commit flow.
    pub fn restore(state_bytes: &[u8]) -> Result<Self> {
        let state: PointCryptoState = serde_json::from_slice(state_bytes)
            .map_err(|e| PointCryptoError::Mls(format!("deserialize state: {e}")))?;

        let mut provider = PointProvider::default();
        provider.import_storage(&state.storage_json)?;

        // Reload the signer from restored storage using the stored public key.
        let signer_pub = hex::decode(&state.signer_public_key)
            .map_err(|e| PointCryptoError::Mls(format!("decode signer key: {e}")))?;
        let signer = SignatureKeyPair::read(
            provider.storage(),
            &signer_pub,
            CIPHERSUITE.signature_algorithm(),
        )
        .ok_or_else(|| PointCryptoError::Mls("signer not found in restored storage".into()))?;

        let credential = BasicCredential::new(state.identity.as_bytes().to_vec());
        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: signer.to_public_vec().into(),
        };

        // Reload each MlsGroup from the restored storage.
        let mut groups = HashMap::new();
        for hex_id in &state.group_ids {
            let gid_bytes = hex::decode(hex_id)
                .map_err(|e| PointCryptoError::Mls(format!("decode group id: {e}")))?;
            let group_id = GroupId::from_slice(&gid_bytes);
            match MlsGroup::load(provider.storage(), &group_id) {
                Ok(Some(g)) => {
                    groups.insert(gid_bytes, g);
                }
                Ok(None) => {
                    tracing_warn(format!(
                        "group {hex_id} not found in restored storage — skipping"
                    ));
                }
                Err(e) => {
                    tracing_warn(format!("group {hex_id} load error: {e:?} — skipping"));
                }
            }
        }

        Ok(Self {
            provider,
            credential: credential_with_key,
            signer,
            groups,
            identity: state.identity,
        })
    }

    /// Export current state for durable storage by the caller.
    /// Should be called after every mutation (create_group, add_member,
    /// process_welcome, process_commit).
    pub fn export_state(&self) -> Result<Vec<u8>> {
        let storage_json = self.provider.export_storage()?;
        let group_ids: Vec<String> = self.groups.keys().map(hex::encode).collect();
        let state = PointCryptoState {
            identity: self.identity.clone(),
            storage_json,
            group_ids,
            signer_public_key: hex::encode(self.signer.to_public_vec()),
        };
        serde_json::to_vec(&state)
            .map_err(|e| PointCryptoError::Mls(format!("serialize state: {e}")))
    }

    pub fn generate_key_package(&self) -> Result<Vec<u8>> {
        let kp_bundle = KeyPackage::builder()
            .build(
                CIPHERSUITE,
                &self.provider,
                &self.signer,
                self.credential.clone(),
            )
            .map_err(|e| PointCryptoError::KeyPackage(format!("{e:?}")))?;

        let kp: KeyPackage = kp_bundle.key_package().clone();
        let serialized = kp
            .tls_serialize_detached()
            .map_err(|e| PointCryptoError::Serialization(format!("{e:?}")))?;
        Ok(serialized)
    }

    pub fn create_group(&mut self, group_id: &[u8]) -> Result<Vec<u8>> {
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .build();

        let group = MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &config,
            GroupId::from_slice(group_id),
            self.credential.clone(),
        )
        .map_err(|e| PointCryptoError::Mls(format!("Create group: {e:?}")))?;

        let gid = group.group_id().as_slice().to_vec();
        self.groups.insert(gid.clone(), group);
        Ok(gid)
    }

    pub fn add_member(
        &mut self,
        group_id: &[u8],
        key_package_bytes: &[u8],
    ) -> Result<AddMemberResult> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| PointCryptoError::GroupNotFound(hex::encode(group_id)))?;

        let kp_in = KeyPackageIn::tls_deserialize_exact(key_package_bytes)
            .map_err(|e| PointCryptoError::KeyPackage(format!("{e:?}")))?;
        let kp: KeyPackage = kp_in
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| PointCryptoError::KeyPackage(format!("Validate: {e:?}")))?;

        let (commit_msg, welcome_msg, _group_info) = group
            .add_members(&self.provider, &self.signer, &[kp])
            .map_err(|e| PointCryptoError::Mls(format!("Add member: {e:?}")))?;

        group
            .merge_pending_commit(&self.provider)
            .map_err(|e| PointCryptoError::Mls(format!("Merge: {e:?}")))?;

        let commit_bytes = commit_msg
            .tls_serialize_detached()
            .map_err(|e| PointCryptoError::Serialization(format!("{e:?}")))?;
        let welcome_bytes = welcome_msg
            .tls_serialize_detached()
            .map_err(|e| PointCryptoError::Serialization(format!("{e:?}")))?;

        Ok(AddMemberResult {
            welcome: welcome_bytes,
            commit: commit_bytes,
        })
    }

    pub fn process_welcome(&mut self, welcome_bytes: &[u8]) -> Result<Vec<u8>> {
        let welcome_msg = MlsMessageIn::tls_deserialize_exact(welcome_bytes)
            .map_err(|e| PointCryptoError::Serialization(format!("{e:?}")))?;

        let welcome = match welcome_msg.extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => return Err(PointCryptoError::Mls("Not a Welcome message".into())),
        };

        let join_config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .build();

        let group = StagedWelcome::new_from_welcome(&self.provider, &join_config, welcome, None)
            .map_err(|e| PointCryptoError::Mls(format!("Stage welcome: {e:?}")))?
            .into_group(&self.provider)
            .map_err(|e| PointCryptoError::Mls(format!("Into group: {e:?}")))?;

        let gid = group.group_id().as_slice().to_vec();
        self.groups.insert(gid.clone(), group);
        Ok(gid)
    }

    pub fn encrypt(&mut self, group_id: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| PointCryptoError::GroupNotFound(hex::encode(group_id)))?;

        let msg = group
            .create_message(&self.provider, &self.signer, plaintext)
            .map_err(|e| PointCryptoError::Mls(format!("Encrypt: {e:?}")))?;

        msg.tls_serialize_detached()
            .map_err(|e| PointCryptoError::Serialization(format!("{e:?}")))
    }

    pub fn decrypt(&mut self, group_id: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| PointCryptoError::GroupNotFound(hex::encode(group_id)))?;

        let msg_in = MlsMessageIn::tls_deserialize_exact(ciphertext)
            .map_err(|e| PointCryptoError::Serialization(format!("{e:?}")))?;

        let protocol_msg = msg_in
            .try_into_protocol_message()
            .map_err(|_| PointCryptoError::DecryptionFailed)?;

        let processed = group
            .process_message(&self.provider, protocol_msg)
            .map_err(|e| PointCryptoError::Mls(format!("Decrypt: {e:?}")))?;

        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => Ok(app.into_bytes()),
            ProcessedMessageContent::StagedCommitMessage(commit) => {
                group
                    .merge_staged_commit(&self.provider, *commit)
                    .map_err(|e| PointCryptoError::Mls(format!("Merge: {e:?}")))?;
                Err(PointCryptoError::InvalidState(
                    "Commit, not app message".into(),
                ))
            }
            _ => Err(PointCryptoError::DecryptionFailed),
        }
    }

    pub fn process_commit(&mut self, group_id: &[u8], commit_bytes: &[u8]) -> Result<()> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| PointCryptoError::GroupNotFound(hex::encode(group_id)))?;

        let msg_in = MlsMessageIn::tls_deserialize_exact(commit_bytes)
            .map_err(|e| PointCryptoError::Serialization(format!("{e:?}")))?;

        let protocol_msg = msg_in
            .try_into_protocol_message()
            .map_err(|_| PointCryptoError::Mls("Not a protocol message".into()))?;

        let processed = group
            .process_message(&self.provider, protocol_msg)
            .map_err(|e| PointCryptoError::Mls(format!("Process commit: {e:?}")))?;

        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(commit) => {
                group
                    .merge_staged_commit(&self.provider, *commit)
                    .map_err(|e| PointCryptoError::Mls(format!("Merge commit: {e:?}")))?;
                Ok(())
            }
            _ => Err(PointCryptoError::InvalidState(
                "Expected commit message".into(),
            )),
        }
    }

    pub fn has_group(&self, group_id: &[u8]) -> bool {
        self.groups.contains_key(group_id)
    }

    pub fn group_member_count(&self, group_id: &[u8]) -> Result<usize> {
        let group = self
            .groups
            .get(group_id)
            .ok_or_else(|| PointCryptoError::GroupNotFound(hex::encode(group_id)))?;
        Ok(group.members().count())
    }

    /// A Signal-style safety number for out-of-band verification: SHA-256 over
    /// the group's member signature (identity) public keys, sorted so both
    /// parties compute the SAME value, rendered as decimal groups. It's derived
    /// from identity keys (not the epoch secret), so it's stable and detects a
    /// substituted key — the point of verification. Both sides comparing the
    /// same number confirms no man-in-the-middle.
    pub fn safety_number(&self, group_id: &[u8]) -> Result<String> {
        use sha2::{Digest, Sha256};
        let group = self
            .groups
            .get(group_id)
            .ok_or_else(|| PointCryptoError::GroupNotFound(hex::encode(group_id)))?;
        let mut keys: Vec<Vec<u8>> = group
            .members()
            .map(|m| m.signature_key.as_slice().to_vec())
            .collect();
        if keys.len() < 2 {
            return Err(PointCryptoError::InvalidState(
                "safety number needs both members in the group".into(),
            ));
        }
        keys.sort();
        let mut hasher = Sha256::new();
        for k in &keys {
            hasher.update(k);
        }
        let digest = hasher.finalize();
        // 8 groups of 5 decimal digits from the 32-byte digest — glanceable.
        let groups: Vec<String> = digest
            .chunks(4)
            .take(8)
            .map(|c| {
                let mut v = 0u32;
                for &b in c {
                    v = v.wrapping_shl(8) | u32::from(b);
                }
                format!("{:05}", v % 100_000)
            })
            .collect();
        Ok(groups.join(" "))
    }
}

fn tracing_warn(msg: String) {
    // flutter_rust_bridge doesn't give us tracing, use eprintln for now
    eprintln!("[point-crypto] WARN: {msg}");
}
