//! Stable transaction ids: the second half of exactly-once delivery.
//!
//! The [`crate::ledger`] prevents duplicates across restarts and backfill;
//! stable transaction ids close the remaining window — a retry (or a
//! post-restart resend) of a send whose first attempt actually landed but
//! whose response was lost is deduped by the homeserver's transaction-id
//! cache instead of appearing twice in the room.

use matrix_sdk::ruma::{EventId, OwnedTransactionId, RoomId};

/// Deterministic transaction id for relaying `source_event` into `target`
/// for a given `purpose` ("relay", "caption", ...).
///
/// Stable across retries AND process restarts. FNV-1a with two seeds; the
/// inputs are globally unique, the 128-bit output is only scoped to this
/// device's transaction namespace.
#[must_use]
pub fn relay_txn_id(source_event: &EventId, target: &RoomId, purpose: &str) -> OwnedTransactionId {
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    fn fnv1a(seed: u64, parts: &[&str]) -> u64 {
        let mut hash = seed;
        for part in parts {
            for byte in part.as_bytes() {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(FNV_PRIME);
            }
            // Separator so ("ab","c") != ("a","bc").
            hash ^= 0xff;
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        hash
    }
    let parts = [source_event.as_str(), target.as_str(), purpose];
    let hi = fnv1a(0xcbf2_9ce4_8422_2325, &parts);
    let lo = fnv1a(0x9e37_79b9_7f4a_7c15, &parts);
    OwnedTransactionId::from(format!("relay{hi:016x}{lo:016x}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};

    #[test]
    fn relay_txn_ids_are_stable_and_scoped() {
        let ev: OwnedEventId = "$abc:hs".try_into().expect("valid event id");
        let room_a: OwnedRoomId = "!a:hs".try_into().expect("valid room id");
        let room_b: OwnedRoomId = "!b:hs".try_into().expect("valid room id");

        // Deterministic: a retry (or a post-restart backfill resend) of the
        // same (event, target) re-uses the exact same transaction id, so the
        // homeserver can dedupe it.
        assert_eq!(
            relay_txn_id(&ev, &room_a, "relay"),
            relay_txn_id(&ev, &room_a, "relay")
        );
        // Scoped: different target or purpose must not collide.
        assert_ne!(
            relay_txn_id(&ev, &room_a, "relay"),
            relay_txn_id(&ev, &room_b, "relay")
        );
        assert_ne!(
            relay_txn_id(&ev, &room_a, "relay"),
            relay_txn_id(&ev, &room_a, "caption")
        );
        // Different source events must not collide either.
        let ev2: OwnedEventId = "$bad:hs".try_into().expect("valid event id");
        assert_ne!(
            relay_txn_id(&ev, &room_a, "relay"),
            relay_txn_id(&ev2, &room_a, "relay")
        );
    }
}
