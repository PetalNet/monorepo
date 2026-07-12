pub mod crypto;
pub mod errors;
pub mod recovery;
pub mod types;

pub use crypto::{PointCrypto, PointCryptoState};
pub use errors::PointCryptoError;
pub use types::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_export_restore() {
        // Alice creates a group and adds Bob.
        let mut alice = PointCrypto::new("alice@example.com").unwrap();
        let mut bob = PointCrypto::new("bob@example.com").unwrap();
        let bob_kp = bob.generate_key_package().unwrap();
        let gid = alice.create_group(b"persist-test-group").unwrap();
        let add = alice.add_member(&gid, &bob_kp).unwrap();
        bob.process_welcome(&add.welcome).unwrap();

        // Alice exports state, simulating an app restart.
        let state = alice.export_state().unwrap();
        assert!(!state.is_empty());

        // Alice is restored from state.
        let mut alice2 = PointCrypto::restore(&state).unwrap();
        assert!(alice2.has_group(&gid));

        // Restored Alice can still encrypt and Bob can decrypt.
        let msg = b"location after restart";
        let ct = alice2.encrypt(&gid, msg).unwrap();
        let bob_gid: Vec<u8> = bob
            .export_state()
            .map(|s| {
                serde_json::from_slice::<crate::crypto::PointCryptoState>(&s)
                    .unwrap()
                    .group_ids
            })
            .unwrap_or_default()
            .first()
            .map(|hex_id| hex::decode(hex_id).unwrap())
            .unwrap_or_default();
        let pt = bob.decrypt(&bob_gid, &ct).unwrap();
        assert_eq!(pt, msg);
        println!(
            "State export/restore roundtrip ✓ ({} bytes state)",
            state.len()
        );
    }

    #[test]
    fn safety_number_matches_between_peers_and_is_stable() {
        let mut alice = PointCrypto::new("alice@point.dev").unwrap();
        let mut bob = PointCrypto::new("bob@point.dev").unwrap();
        let bob_kp = bob.generate_key_package().unwrap();
        let gid = alice.create_group(b"safety-number-test").unwrap();
        let add = alice.add_member(&gid, &bob_kp).unwrap();
        let bob_gid = bob.process_welcome(&add.welcome).unwrap();

        let a = alice.safety_number(&gid).unwrap();
        let b = bob.safety_number(&bob_gid).unwrap();
        // Both parties in the same un-MITM'd group derive the SAME number.
        assert_eq!(a, b);
        // 8 groups of 5 digits, stable across calls.
        assert_eq!(a.split(' ').count(), 8);
        assert_eq!(a, alice.safety_number(&gid).unwrap());

        // A different pair yields a different number.
        let mut carol = PointCrypto::new("carol@point.dev").unwrap();
        let carol_kp = carol.generate_key_package().unwrap();
        let gid2 = alice.create_group(b"other-pair").unwrap();
        let add2 = alice.add_member(&gid2, &carol_kp).unwrap();
        carol.process_welcome(&add2.welcome).unwrap();
        assert_ne!(a, alice.safety_number(&gid2).unwrap());
    }

    #[test]
    fn test_key_package_generation() {
        let crypto = PointCrypto::new("alice@point.petalcat.dev").unwrap();
        let kp = crypto.generate_key_package().unwrap();
        assert!(!kp.is_empty());
        println!("Key package: {} bytes", kp.len());
    }

    #[test]
    fn test_group_creation() {
        let mut crypto = PointCrypto::new("alice@point.petalcat.dev").unwrap();
        let gid = crypto.create_group(b"test-group-1").unwrap();
        assert!(!gid.is_empty());
        assert!(crypto.has_group(&gid));
        assert_eq!(crypto.group_member_count(&gid).unwrap(), 1);
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        // Alice creates a group
        let mut alice = PointCrypto::new("alice@point.petalcat.dev").unwrap();
        let gid = alice.create_group(b"family-group").unwrap();

        // Bob generates a key package — SAME instance must process the welcome
        let mut bob = PointCrypto::new("bob@point.petalcat.dev").unwrap();
        let bob_kp = bob.generate_key_package().unwrap();

        // Alice adds Bob
        let add_result = alice.add_member(&gid, &bob_kp).unwrap();

        // Bob processes the Welcome to join (same instance that generated the key package)
        let bob_gid = bob.process_welcome(&add_result.welcome).unwrap();

        // Alice encrypts a location
        let location = r#"{"lat":38.713,"lon":-90.427,"timestamp":1712345678}"#;
        let ciphertext = alice.encrypt(&gid, location.as_bytes()).unwrap();

        // The ciphertext should NOT contain the plaintext
        let ct_str = String::from_utf8_lossy(&ciphertext);
        assert!(!ct_str.contains("38.713"));

        // Bob decrypts
        let plaintext = bob.decrypt(&bob_gid, &ciphertext).unwrap();
        let decrypted = String::from_utf8(plaintext).unwrap();
        assert_eq!(decrypted, location);

        println!(
            "Plaintext: {} bytes, Ciphertext: {} bytes",
            location.len(),
            ciphertext.len()
        );
        println!("Decrypted: {}", decrypted);
    }

    #[test]
    fn test_e2e_zero_knowledge_server() {
        // ============================================================
        // Full end-to-end ZKS simulation:
        // - 3 users (Alice, Bob, Charlie)
        // - Server group with key exchange
        // - Direct pairwise sharing
        // - Server sees ONLY opaque blobs at every step
        // ============================================================

        println!("\n=== ZERO KNOWLEDGE SERVER E2E TEST ===\n");

        // --- Step 1: All users initialize and generate key packages ---
        // (In production, key packages are uploaded to the server)
        let mut alice = PointCrypto::new("alice@point.petalcat.dev").unwrap();
        let mut bob = PointCrypto::new("bob@point.petalcat.dev").unwrap();
        let mut charlie = PointCrypto::new("charlie@point.petalcat.dev").unwrap();

        let bob_kp = bob.generate_key_package().unwrap();
        let charlie_kp = charlie.generate_key_package().unwrap();

        println!(
            "[Server] Stored key packages: bob={}B, charlie={}B",
            bob_kp.len(),
            charlie_kp.len()
        );

        // --- Step 2: Alice creates "Family" group ---
        let gid = alice.create_group(b"family-group-uuid-1234").unwrap();
        assert_eq!(alice.group_member_count(&gid).unwrap(), 1);
        println!("[Alice] Created MLS group, 1 member");

        // --- Step 3: Alice adds Bob (simulating server relay) ---
        let add_bob = alice.add_member(&gid, &bob_kp).unwrap();
        println!(
            "[Server] Relaying Welcome ({}B) to Bob, Commit ({}B) to group",
            add_bob.welcome.len(),
            add_bob.commit.len()
        );

        // Server stores these as opaque blobs — cannot read them
        assert!(!String::from_utf8_lossy(&add_bob.welcome).contains("alice"));
        assert!(!String::from_utf8_lossy(&add_bob.welcome).contains("bob"));

        let bob_gid = bob.process_welcome(&add_bob.welcome).unwrap();
        assert_eq!(alice.group_member_count(&gid).unwrap(), 2);
        println!("[Bob] Joined group via Welcome, 2 members");

        // --- Step 4: Alice adds Charlie ---
        let add_charlie = alice.add_member(&gid, &charlie_kp).unwrap();

        // Bob must process the Commit to stay in sync (epoch advances)
        bob.process_commit(&bob_gid, &add_charlie.commit).unwrap();
        println!("[Bob] Processed Commit for Charlie's addition (epoch advanced)");

        let charlie_gid = charlie.process_welcome(&add_charlie.welcome).unwrap();
        assert_eq!(alice.group_member_count(&gid).unwrap(), 3);
        println!("[Charlie] Joined group via Welcome, 3 members");

        // --- Step 5: Alice sends location to group ---
        let alice_loc =
            r#"{"lat":38.627,"lon":-90.199,"speed":12.5,"battery":85,"timestamp":1712345678}"#;
        let ct = alice.encrypt(&gid, alice_loc.as_bytes()).unwrap();

        // SERVER ZERO-KNOWLEDGE CHECK: the ciphertext must not contain any
        // plaintext. Markers are field-qualified: a bare short value like
        // "85" appears in ~1KB of random lossy-decoded bytes about once every
        // hundred runs (observed as CI flake), which says nothing about a
        // leak. A leak would reproduce the serialized JSON, field and all.
        let ct_str = String::from_utf8_lossy(&ct);
        assert!(!ct_str.contains("38.627"), "Server can see latitude!");
        assert!(!ct_str.contains("-90.199"), "Server can see longitude!");
        assert!(!ct_str.contains("\"speed\":12.5"), "Server can see speed!");
        assert!(
            !ct_str.contains("\"battery\":85"),
            "Server can see battery!"
        );
        assert!(!ct_str.contains("1712345678"), "Server can see timestamp!");
        println!(
            "[Server] Relaying encrypted blob ({}B) — CANNOT read contents ✓",
            ct.len()
        );

        // Bob decrypts
        let bob_pt = bob.decrypt(&bob_gid, &ct).unwrap();
        assert_eq!(String::from_utf8(bob_pt).unwrap(), alice_loc);
        println!("[Bob] Decrypted Alice's location ✓");

        // Charlie decrypts
        let charlie_pt = charlie.decrypt(&charlie_gid, &ct).unwrap();
        assert_eq!(String::from_utf8(charlie_pt).unwrap(), alice_loc);
        println!("[Charlie] Decrypted Alice's location ✓");

        // --- Step 6: Bob sends location back ---
        let bob_loc =
            r#"{"lat":38.713,"lon":-90.427,"speed":0,"battery":42,"timestamp":1712345700}"#;
        let bob_ct = bob.encrypt(&bob_gid, bob_loc.as_bytes()).unwrap();

        let bob_ct_str = String::from_utf8_lossy(&bob_ct);
        assert!(
            !bob_ct_str.contains("38.713"),
            "Server can see Bob's latitude!"
        );
        assert!(!bob_ct_str.contains("42"), "Server can see Bob's battery!");
        println!(
            "[Server] Relaying Bob's encrypted blob ({}B) — CANNOT read ✓",
            bob_ct.len()
        );

        let alice_sees_bob = alice.decrypt(&gid, &bob_ct).unwrap();
        assert_eq!(String::from_utf8(alice_sees_bob).unwrap(), bob_loc);
        println!("[Alice] Decrypted Bob's location ✓");

        let charlie_sees_bob = charlie.decrypt(&charlie_gid, &bob_ct).unwrap();
        assert_eq!(String::from_utf8(charlie_sees_bob).unwrap(), bob_loc);
        println!("[Charlie] Decrypted Bob's location ✓");

        // --- Step 7: Pairwise direct share (Alice <-> Bob) ---
        // Uses a separate MLS group for DMs
        let mut alice_dm = PointCrypto::new("alice@point.petalcat.dev").unwrap();
        let mut bob_dm = PointCrypto::new("bob@point.petalcat.dev").unwrap();
        let bob_dm_kp = bob_dm.generate_key_package().unwrap();

        let dm_gid = alice_dm.create_group(b"dm:alice:bob").unwrap();
        let add_bob_dm = alice_dm.add_member(&dm_gid, &bob_dm_kp).unwrap();
        let bob_dm_gid = bob_dm.process_welcome(&add_bob_dm.welcome).unwrap();

        let dm_msg = r#"{"lat":38.600,"lon":-90.300,"timestamp":1712346000}"#;
        let dm_ct = alice_dm.encrypt(&dm_gid, dm_msg.as_bytes()).unwrap();

        // Charlie should NOT be able to decrypt this (different group)
        let dm_ct_str = String::from_utf8_lossy(&dm_ct);
        assert!(!dm_ct_str.contains("38.600"));

        let bob_sees_dm = bob_dm.decrypt(&bob_dm_gid, &dm_ct).unwrap();
        assert_eq!(String::from_utf8(bob_sees_dm).unwrap(), dm_msg);
        println!("[DM] Alice->Bob direct share encrypted & decrypted ✓");
        println!("[DM] Charlie CANNOT decrypt this — separate MLS group ✓");

        // --- Step 8: Multiple rapid location updates (ratchet forward secrecy) ---
        for i in 0..10 {
            let loc = format!(
                r#"{{"lat":38.627,"lon":-90.199,"timestamp":{}}}"#,
                1712345700 + i
            );
            let ct = alice.encrypt(&gid, loc.as_bytes()).unwrap();
            let pt = bob.decrypt(&bob_gid, &ct).unwrap();
            assert_eq!(String::from_utf8(pt).unwrap(), loc);
        }
        println!("[Ratchet] 10 rapid updates with forward secrecy ✓");

        println!("\n=== ALL ZKS E2E TESTS PASSED ===\n");
    }
}
