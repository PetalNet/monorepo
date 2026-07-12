//! Zero-knowledge account recovery.
//!
//! A user's MLS identity + group state lives on-device. Lose the device and you
//! lose every end-to-end session. Recovery fixes that WITHOUT trusting the
//! server: the device encrypts its exported MLS state under a key derived from a
//! **recovery code** that only the user holds, and the home-server stores the
//! result as opaque ciphertext. The server never sees the code, the derived key,
//! or the plaintext state — it holds a blob it cannot open. A new device fetches
//! the blob and, given the recovery code, decrypts and restores the identity.
//!
//! Blob layout (all client-produced; the server treats it as bytes):
//!   MAGIC(4) ‖ salt(16) ‖ nonce(24) ‖ XChaCha20-Poly1305(state)
//! The KDF is Argon2id (m=64 MiB, t=3, p=1) — recovery is rare, so we can afford
//! firm parameters against an offline guess of a stolen (but useless-alone) blob.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::{Rng, RngCore};
use zeroize::Zeroize;

const MAGIC: &[u8; 4] = b"PTR1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24; // XChaCha20 extended nonce
const KEY_LEN: usize = 32;
const HEADER_LEN: usize = 4 + SALT_LEN + NONCE_LEN;

fn kdf() -> Argon2<'static> {
    let params = Params::new(64 * 1024, 3, 1, Some(KEY_LEN)).expect("static argon2 params valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Canonicalize a recovery code so casing, spacing, dashes, and the usual
/// look-alike substitutions all derive the same key. Generated codes use a
/// Crockford-style alphabet (no I/L/O/U), so they are stable under this map.
fn normalize_code(code: &str) -> String {
    code.chars()
        .filter_map(|c| match c.to_ascii_uppercase() {
            'I' | 'L' => Some('1'),
            'O' => Some('0'),
            c @ ('0'..='9' | 'A'..='Z') => Some(c),
            _ => None, // drop dashes, spaces, punctuation
        })
        .collect()
}

fn derive_key(code: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    let normalized = normalize_code(code);
    if normalized.len() < 8 {
        return Err("recovery code too short".into());
    }
    let mut key = [0u8; KEY_LEN];
    kdf()
        .hash_password_into(normalized.as_bytes(), salt, &mut key)
        .map_err(|e| format!("kdf: {e}"))?;
    Ok(key)
}

/// Encrypt an exported MLS state blob under `recovery_code`. Output is the
/// server-opaque backup blob.
pub fn encrypt(state: &[u8], recovery_code: &str) -> Result<Vec<u8>, String> {
    // Generate the random array directly (no zero-init buffer) so both the code
    // and static analysis see fresh CSPRNG bytes as the salt/nonce source.
    let salt: [u8; SALT_LEN] = OsRng.gen();
    let nonce: [u8; NONCE_LEN] = OsRng.gen();

    let mut key = derive_key(recovery_code, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|e| e.to_string())?;
    key.zeroize();

    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), state)
        .map_err(|_| "recovery encrypt failed".to_string())?;

    let mut out = Vec::with_capacity(HEADER_LEN + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypt a backup blob produced by [`encrypt`]. A wrong code or a corrupt blob
/// is an authentication failure (fail-closed), not a silent partial.
pub fn decrypt(blob: &[u8], recovery_code: &str) -> Result<Vec<u8>, String> {
    if blob.len() < HEADER_LEN || &blob[..4] != MAGIC {
        return Err("malformed recovery blob".into());
    }
    let salt = &blob[4..4 + SALT_LEN];
    let nonce = &blob[4 + SALT_LEN..HEADER_LEN];
    let ct = &blob[HEADER_LEN..];

    let mut key = derive_key(recovery_code, salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|e| e.to_string())?;
    key.zeroize();

    cipher
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| "recovery decrypt failed (wrong code or corrupt backup)".to_string())
}

/// A fresh high-entropy recovery code: 120 bits as 24 Crockford-base32 symbols,
/// grouped `XXXXXX-XXXXXX-XXXXXX-XXXXXX` for legibility. The alphabet omits
/// I/L/O/U so it survives [`normalize_code`] unchanged.
pub fn generate_code() -> String {
    const ALPHA: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut raw = [0u8; 15]; // 120 bits -> exactly 24 base32 symbols
    OsRng.fill_bytes(&mut raw);

    let mut out = String::with_capacity(24 + 3);
    let mut acc = 0u32;
    let mut nbits = 0u32;
    let mut count = 0usize;
    for &b in &raw {
        acc = (acc << 8) | u32::from(b);
        nbits += 8;
        while nbits >= 5 {
            nbits -= 5;
            let idx = ((acc >> nbits) & 0x1f) as usize;
            if count > 0 && count.is_multiple_of(6) {
                out.push('-');
            }
            out.push(ALPHA[idx] as char);
            count += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_recovers_exact_state() {
        let state = b"pretend-exported-mls-state-blob".to_vec();
        let code = generate_code();
        let blob = encrypt(&state, &code).unwrap();
        assert_ne!(blob, state);
        assert_eq!(decrypt(&blob, &code).unwrap(), state);
    }

    #[test]
    fn wrong_code_fails_closed() {
        let blob = encrypt(b"secret", "MASTER-CODE-1234").unwrap();
        assert!(decrypt(&blob, "WRONG-CODE-9999").is_err());
    }

    #[test]
    fn code_normalization_tolerates_casing_and_spacing() {
        let blob = encrypt(b"secret state", "ABCDEF-GHJKMN").unwrap();
        // Lowercase, extra spaces, and I/L/O look-alike glyphs map to one key.
        assert_eq!(
            decrypt(&blob, "  abcdef ghjkmn  ").unwrap(),
            b"secret state"
        );
    }

    #[test]
    fn blob_carries_no_plaintext() {
        let state = b"38.627,-90.199 is a real location";
        let blob = encrypt(state, &generate_code()).unwrap();
        assert!(!blob.windows(4).any(|w| w == b"38.6"));
    }

    #[test]
    fn tampered_blob_rejected() {
        let code = "TAMPER-TEST-CODE";
        let mut blob = encrypt(b"state", code).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xff; // flip a ciphertext byte
        assert!(decrypt(&blob, code).is_err());
    }

    #[test]
    fn malformed_blob_rejected() {
        assert!(decrypt(b"too-short", "code-code-code").is_err());
        assert!(decrypt(&[0u8; 64], "code-code-code").is_err()); // bad magic
    }

    #[test]
    fn generated_codes_are_unique_and_shaped() {
        let a = generate_code();
        let b = generate_code();
        assert_ne!(a, b);
        assert_eq!(a.len(), 24 + 3); // 24 symbols + 3 dashes
        assert_eq!(a.matches('-').count(), 3);
    }
}
