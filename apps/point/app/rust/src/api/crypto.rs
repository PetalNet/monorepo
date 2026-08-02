//! The MLS surface exposed to Dart. Wraps `point_core::PointCrypto` behind a
//! Mutex (FFI calls may interleave). Every method that mutates group state
//! returns nothing extra — the Dart layer calls [`PointMls::export_state`]
//! after mutations and persists the blob to secure storage (MLS durability,
//! GO-bar #2). Nothing here ever exposes plaintext beyond what the caller
//! already holds.

use std::sync::Mutex;

use flutter_rust_bridge::frb;
use point_core::PointCrypto;

/// Opaque handle to a live MLS identity + its groups. Held by Dart as a
/// `RustAutoOpaque<PointMls>`.
pub struct PointMls {
    inner: Mutex<PointCrypto>,
}

/// Welcome (for the new member) + Commit (for existing members) from an add.
pub struct AddMemberResult {
    pub welcome: Vec<u8>,
    pub commit: Vec<u8>,
}

impl PointMls {
    /// Fresh identity — generates a new signing key and empty state.
    #[frb(sync)]
    pub fn new(identity: String) -> Result<PointMls, String> {
        PointCrypto::new(&identity)
            .map(|c| PointMls {
                inner: Mutex::new(c),
            })
            .map_err(|e| e.to_string())
    }

    /// Restore from a previously exported state blob (secure storage). On error
    /// the caller should fall back to `new()` and re-join via Welcome/Commit.
    #[frb(sync)]
    pub fn restore(state: Vec<u8>) -> Result<PointMls, String> {
        PointCrypto::restore(&state)
            .map(|c| PointMls {
                inner: Mutex::new(c),
            })
            .map_err(|e| e.to_string())
    }

    /// Serialize the full MLS state for durable storage. Call after every
    /// mutation (create_group, add_member, process_welcome, process_commit).
    pub fn export_state(&self) -> Result<Vec<u8>, String> {
        self.lock().export_state().map_err(|e| e.to_string())
    }

    /// A fresh one-time KeyPackage to upload to the server pool.
    pub fn generate_key_package(&self) -> Result<Vec<u8>, String> {
        self.lock()
            .generate_key_package()
            .map_err(|e| e.to_string())
    }

    pub fn create_group(&self, group_id: Vec<u8>) -> Result<Vec<u8>, String> {
        self.lock()
            .create_group(&group_id)
            .map_err(|e| e.to_string())
    }

    pub fn add_member(
        &self,
        group_id: Vec<u8>,
        key_package: Vec<u8>,
    ) -> Result<AddMemberResult, String> {
        self.lock()
            .add_member(&group_id, &key_package)
            .map(|r| AddMemberResult {
                welcome: r.welcome,
                commit: r.commit,
            })
            .map_err(|e| e.to_string())
    }

    /// Join a group from a Welcome; returns the group id.
    pub fn process_welcome(&self, welcome: Vec<u8>) -> Result<Vec<u8>, String> {
        self.lock()
            .process_welcome(&welcome)
            .map_err(|e| e.to_string())
    }

    /// Apply a Commit (membership change) to an existing group.
    pub fn process_commit(&self, group_id: Vec<u8>, commit: Vec<u8>) -> Result<(), String> {
        self.lock()
            .process_commit(&group_id, &commit)
            .map_err(|e| e.to_string())
    }

    /// Encrypt a location fix for a group. Returns opaque MLS ciphertext.
    pub fn encrypt(&self, group_id: Vec<u8>, plaintext: Vec<u8>) -> Result<Vec<u8>, String> {
        self.lock()
            .encrypt(&group_id, &plaintext)
            .map_err(|e| e.to_string())
    }

    /// Decrypt a group ciphertext back to plaintext.
    pub fn decrypt(&self, group_id: Vec<u8>, ciphertext: Vec<u8>) -> Result<Vec<u8>, String> {
        self.lock()
            .decrypt(&group_id, &ciphertext)
            .map_err(|e| e.to_string())
    }

    #[frb(sync)]
    pub fn has_group(&self, group_id: Vec<u8>) -> bool {
        self.lock().has_group(&group_id)
    }

    /// A Signal-style safety number for a pairwise group — both members compute
    /// the same value from their sorted identity keys, for out-of-band verify.
    pub fn safety_number(&self, group_id: Vec<u8>) -> Result<String, String> {
        self.lock()
            .safety_number(&group_id)
            .map_err(|e| e.to_string())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, PointCrypto> {
        // Recover from a poisoned mutex (a panic deep in openmls on malformed
        // input) instead of aborting every future call across the FFI boundary
        // — a bad frame should fail this call, not brick the identity.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}
