//! Token authority (CP4): mints, rotates, and verifies scoped agent tokens
//! over the vault. The control plane is the ONLY minter; agents receive their
//! token at enrollment and on rotation.
//!
//! Verification accepts the current secret, or — within the rotation grace
//! window — the previous one, so an agent that hasn't picked up its new token
//! yet doesn't hard-fail mid-rotation.

use crate::vault::{CredStore, Credential};

pub const ROTATION_GRACE_SECS: i64 = 15 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verify {
    /// Matches the current secret.
    Current,
    /// Matches the previous secret inside the grace window — caller should
    /// push the new token to the agent again.
    GracePrevious,
    Rejected,
}

pub struct TokenAuthority<'a> {
    pub store: &'a dyn CredStore,
}

fn cred_name(handle: &str, scope: &str) -> String {
    format!("agent:{handle}:{scope}")
}

impl<'a> TokenAuthority<'a> {
    /// Mint a fresh token for (agent, scope). Returns the plaintext token —
    /// hand it to the agent over the backchannel; it is also durable in the
    /// vault (0600) because the authority must be able to re-issue it.
    pub fn mint(&self, handle: &str, scope: &str, now_rfc3339: &str) -> Result<String, String> {
        let name = cred_name(handle, scope);
        if self.store.get(&name)?.is_some() {
            return Err(format!("token {name} already exists — rotate instead"));
        }
        let secret = uuid::Uuid::new_v4().to_string();
        self.store.put(&Credential {
            name,
            secret: secret.clone(),
            previous: None,
            version: 1,
            created_at: now_rfc3339.to_string(),
            rotated_at: None,
        })?;
        Ok(secret)
    }

    /// Rotate: new secret becomes current, old secret survives as `previous`
    /// for the grace window.
    pub fn rotate(&self, handle: &str, scope: &str, now_rfc3339: &str) -> Result<String, String> {
        let name = cred_name(handle, scope);
        let old = self
            .store
            .get(&name)?
            .ok_or(format!("no token {name} to rotate"))?;
        let secret = uuid::Uuid::new_v4().to_string();
        self.store.put(&Credential {
            name,
            secret: secret.clone(),
            previous: Some(old.secret),
            version: old.version + 1,
            created_at: old.created_at,
            rotated_at: Some(now_rfc3339.to_string()),
        })?;
        Ok(secret)
    }

    /// Re-issue the current token (the "Parker never touches creds" path:
    /// the authority can always hand an agent its own token again).
    pub fn reissue(&self, handle: &str, scope: &str) -> Result<Option<String>, String> {
        Ok(self.store.get(&cred_name(handle, scope))?.map(|c| c.secret))
    }

    /// Verify a presented token. `now_epoch`/`rotated_at_epoch` drive the
    /// grace-window check; a missing rotated_at means no grace path exists.
    pub fn verify(
        &self,
        handle: &str,
        scope: &str,
        presented: &str,
        now_epoch: i64,
    ) -> Result<Verify, String> {
        let Some(cred) = self.store.get(&cred_name(handle, scope))? else {
            return Ok(Verify::Rejected);
        };
        if constant_time_eq(cred.secret.as_bytes(), presented.as_bytes()) {
            return Ok(Verify::Current);
        }
        if let (Some(previous), Some(rotated_at)) = (&cred.previous, &cred.rotated_at) {
            let rotated_epoch = chrono::DateTime::parse_from_rfc3339(rotated_at)
                .map(|t| t.timestamp())
                .unwrap_or(0);
            if now_epoch - rotated_epoch <= ROTATION_GRACE_SECS
                && constant_time_eq(previous.as_bytes(), presented.as_bytes())
            {
                return Ok(Verify::GracePrevious);
            }
        }
        Ok(Verify::Rejected)
    }
}

/// Constant-time comparison — a token check must not leak prefix length.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::FileVault;

    #[test]
    fn mint_rotate_verify_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let vault = FileVault::open(dir.path()).unwrap();
        let auth = TokenAuthority { store: &vault };

        let t1 = auth
            .mint("janet", "tracker", "2026-07-12T11:00:00Z")
            .unwrap();
        assert_eq!(
            auth.verify("janet", "tracker", &t1, 0).unwrap(),
            Verify::Current
        );
        assert_eq!(auth.reissue("janet", "tracker").unwrap(), Some(t1.clone()));
        assert!(auth
            .mint("janet", "tracker", "2026-07-12T11:00:00Z")
            .is_err());

        // Rotate at T. Old token verifies as grace inside the window…
        let rotated_at = "2026-07-12T12:00:00Z";
        let rotated_epoch = chrono::DateTime::parse_from_rfc3339(rotated_at)
            .unwrap()
            .timestamp();
        let t2 = auth.rotate("janet", "tracker", rotated_at).unwrap();
        assert_ne!(t1, t2);
        assert_eq!(
            auth.verify("janet", "tracker", &t2, rotated_epoch + 10)
                .unwrap(),
            Verify::Current
        );
        assert_eq!(
            auth.verify("janet", "tracker", &t1, rotated_epoch + 60)
                .unwrap(),
            Verify::GracePrevious
        );
        // …and is rejected after it.
        assert_eq!(
            auth.verify(
                "janet",
                "tracker",
                &t1,
                rotated_epoch + ROTATION_GRACE_SECS + 1
            )
            .unwrap(),
            Verify::Rejected
        );
        // Unknown scope/agent/garbage.
        assert_eq!(
            auth.verify("janet", "voice", &t2, 0).unwrap(),
            Verify::Rejected
        );
        assert_eq!(
            auth.verify("other", "tracker", &t2, 0).unwrap(),
            Verify::Rejected
        );
        assert_eq!(
            auth.verify("janet", "tracker", "nope", 0).unwrap(),
            Verify::Rejected
        );
    }

    #[test]
    fn double_rotation_expires_the_oldest_token() {
        let dir = tempfile::tempdir().unwrap();
        let vault = FileVault::open(dir.path()).unwrap();
        let auth = TokenAuthority { store: &vault };
        let t1 = auth
            .mint("janet", "tracker", "2026-07-12T11:00:00Z")
            .unwrap();
        let _t2 = auth
            .rotate("janet", "tracker", "2026-07-12T12:00:00Z")
            .unwrap();
        let t3 = auth
            .rotate("janet", "tracker", "2026-07-12T12:05:00Z")
            .unwrap();
        // t1 is two generations old: rejected even inside any grace window.
        let epoch = chrono::DateTime::parse_from_rfc3339("2026-07-12T12:05:30Z")
            .unwrap()
            .timestamp();
        assert_eq!(
            auth.verify("janet", "tracker", &t1, epoch).unwrap(),
            Verify::Rejected
        );
        assert_eq!(
            auth.verify("janet", "tracker", &t3, epoch).unwrap(),
            Verify::Current
        );
    }
}
