//! This instance's Ed25519 server signing key (M3 federation).
//!
//! Trust decision #1/#2 (baked in by the orchestrator): every instance owns one
//! Ed25519 keypair, generated on first boot and persisted in `server_keys`
//! (single row). The PUBLIC half is published as hex via `/.well-known/point`;
//! peers verify our outbound S2S signatures with it. Signing/verification are
//! over the EXACT request-body bytes — never a re-serialized struct — which is
//! why [`sign`]/[`verify`] take raw `&[u8]` and are pure (unit-testable).
//!
//! The private key (a 32-byte seed) never leaves the DB row and is never logged.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use sqlx::PgPool;

/// Load the persisted signing key, generating + persisting one on first boot.
///
/// Race-safe: a concurrent first-boot insert loses the `ON CONFLICT DO NOTHING`
/// and both callers re-read the single canonical row, so every process on this
/// database ends up with the same key.
pub async fn load_or_generate(pool: &PgPool) -> Result<SigningKey, sqlx::Error> {
    let existing: Option<(Vec<u8>,)> =
        sqlx::query_as("SELECT private_key FROM server_keys WHERE id = 1")
            .fetch_optional(pool)
            .await?;

    let seed_bytes = match existing {
        Some((b,)) => b,
        None => {
            let seed: [u8; 32] = rand::random();
            let signing = SigningKey::from_bytes(&seed);
            let public = signing.verifying_key().to_bytes();
            sqlx::query(
                "INSERT INTO server_keys (id, private_key, public_key)
                 VALUES (1, $1, $2)
                 ON CONFLICT (id) DO NOTHING",
            )
            .bind(seed.as_slice())
            .bind(public.as_slice())
            .execute(pool)
            .await?;
            // Re-read the canonical row: if a concurrent boot won the insert, we
            // adopt its key rather than our discarded local one.
            let (b,): (Vec<u8>,) =
                sqlx::query_as("SELECT private_key FROM server_keys WHERE id = 1")
                    .fetch_one(pool)
                    .await?;
            b
        }
    };

    let seed: [u8; 32] = seed_bytes
        .as_slice()
        .try_into()
        .map_err(|_| sqlx::Error::Decode("server_keys.private_key is not 32 bytes".into()))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Public verifying key, hex-encoded — what `/.well-known/point` publishes.
pub fn public_key_hex(key: &SigningKey) -> String {
    hex::encode(key.verifying_key().to_bytes())
}

/// Sign the exact bytes; returns the 64-byte Ed25519 signature as hex.
pub fn sign(key: &SigningKey, bytes: &[u8]) -> String {
    let sig: Signature = key.sign(bytes);
    hex::encode(sig.to_bytes())
}

/// Verify a hex signature over the exact bytes against a hex public key.
///
/// Fails closed on any malformed input (bad hex, wrong length, non-canonical
/// key/signature). Uses `verify_strict` to reject the known Ed25519 malleability
/// edge cases.
pub fn verify(pubkey_hex: &str, bytes: &[u8], sig_hex: &str) -> bool {
    let Ok(pk_bytes) = hex::decode(pubkey_hex) else {
        return false;
    };
    let Ok(pk_arr) = <[u8; 32]>::try_from(pk_bytes.as_slice()) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk_arr) else {
        return false;
    };
    let Ok(sig_bytes) = hex::decode(sig_hex) else {
        return false;
    };
    let Ok(sig_arr) = <[u8; 64]>::try_from(sig_bytes.as_slice()) else {
        return false;
    };
    let sig = Signature::from_bytes(&sig_arr);
    vk.verify_strict(bytes, &sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> SigningKey {
        let seed: [u8; 32] = rand::random();
        SigningKey::from_bytes(&seed)
    }

    #[test]
    fn sign_verify_roundtrip() {
        let key = test_key();
        let pubkey = public_key_hex(&key);
        let body = br#"{"sender":"a@x","recipient":"b@y","message_type":"share.request"}"#;
        let sig = sign(&key, body);
        assert!(verify(&pubkey, body, &sig), "valid signature must verify");
    }

    #[test]
    fn verify_rejects_tampered_body() {
        let key = test_key();
        let pubkey = public_key_hex(&key);
        let body = b"the exact bytes that were signed";
        let sig = sign(&key, body);
        // A single flipped byte must fail — we verify the raw bytes, so any
        // mutation (including a serde re-serialization) breaks verification.
        let mut tampered = body.to_vec();
        tampered[0] ^= 0x01;
        assert!(!verify(&pubkey, &tampered, &sig));
    }

    #[test]
    fn verify_rejects_wrong_key() {
        let key = test_key();
        let other = test_key();
        let body = b"body";
        let sig = sign(&key, body);
        assert!(!verify(&public_key_hex(&other), body, &sig));
    }

    #[test]
    fn verify_rejects_malformed_inputs() {
        let key = test_key();
        let pubkey = public_key_hex(&key);
        let sig = sign(&key, b"body");
        assert!(!verify("not-hex", b"body", &sig));
        assert!(!verify(&pubkey, b"body", "not-hex"));
        assert!(!verify("abcd", b"body", &sig)); // wrong-length key
        assert!(!verify(&pubkey, b"body", "abcd")); // wrong-length sig
    }

    #[sqlx::test]
    async fn load_or_generate_is_stable(pool: PgPool) {
        let k1 = load_or_generate(&pool).await.unwrap();
        let k2 = load_or_generate(&pool).await.unwrap();
        // Second load returns the persisted key, not a fresh one.
        assert_eq!(k1.to_bytes(), k2.to_bytes());
        assert_eq!(public_key_hex(&k1), public_key_hex(&k2));
    }
}
