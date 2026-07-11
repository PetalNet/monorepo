//! User provisioning shared by password registration and OIDC first-login.

use sqlx::{Postgres, Transaction};

/// Create a local user, their `person` entity, and their primary device inside
/// the caller's transaction — all three exist or none do (D-008: exactly one
/// person entity per user). `password_hash: None` means an OIDC-only account,
/// which password login must reject. `oidc` is the IdP `(issuer, subject)` this
/// account is bound to (None for password accounts) — the durable identity key
/// OIDC login matches on, never the mutable username.
pub async fn create_local_user(
    tx: &mut Transaction<'_, Postgres>,
    user_id: &str,
    display_name: &str,
    password_hash: Option<&str>,
    is_admin: bool,
    device_name: &str,
    oidc: Option<(&str, &str)>,
) -> Result<(), sqlx::Error> {
    let (oidc_issuer, oidc_subject) = match oidc {
        Some((iss, sub)) => (Some(iss), Some(sub)),
        None => (None, None),
    };
    sqlx::query(
        "INSERT INTO users (id, display_name, password_hash, is_admin, oidc_issuer, oidc_subject)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(user_id)
    .bind(display_name)
    .bind(password_hash)
    .bind(is_admin)
    .bind(oidc_issuer)
    .bind(oidc_subject)
    .execute(&mut **tx)
    .await?;
    sqlx::query("INSERT INTO entities (kind, owner_id, display_name) VALUES ('person', $1, $2)")
        .bind(user_id)
        .bind(display_name)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO devices (user_id, name, is_primary) VALUES ($1, $2, TRUE)")
        .bind(user_id)
        .bind(device_name)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
