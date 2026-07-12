//! Zero-knowledge recovery surface exposed to Dart. Thin wrappers over
//! `point_core::recovery`: the device encrypts its exported MLS state under a
//! user-held recovery code before uploading the opaque blob to the home-server,
//! and decrypts a fetched blob on a new device to restore the identity. The
//! recovery code and the derived key never leave the device.

use flutter_rust_bridge::frb;

/// A fresh high-entropy recovery code (24 Crockford-base32 symbols, grouped).
/// Show it to the user ONCE at enrollment — it is the only thing that can
/// decrypt their backup, and the server never learns it.
#[frb(sync)]
pub fn generate_recovery_code() -> String {
    point_core::recovery::generate_code()
}

/// Encrypt an exported MLS state blob under `recovery_code`. Upload the result
/// as-is; the server stores it as opaque bytes.
#[frb(sync)]
pub fn recovery_encrypt(state: Vec<u8>, recovery_code: String) -> Result<Vec<u8>, String> {
    point_core::recovery::encrypt(&state, &recovery_code)
}

/// Decrypt a backup blob fetched from the server. Feed the result to
/// `PointMls.restore`. A wrong code or corrupt blob fails closed.
#[frb(sync)]
pub fn recovery_decrypt(blob: Vec<u8>, recovery_code: String) -> Result<Vec<u8>, String> {
    point_core::recovery::decrypt(&blob, &recovery_code)
}
