//! Public peer-invite landing plus admin-only registration invites and info.

use axum::extract::{Path, State};
use axum::response::Html;
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

/// Public fallback for a universal peer-invite URL. Android App Links open the
/// installed app before this route is requested; every other client gets an
/// honest, usable install/server-choice page and a custom-scheme retry.
pub async fn peer_invite_landing(Path(user_id): Path<String>) -> ApiResult<Html<String>> {
    if !is_federated_handle(&user_id) {
        return Err(AppError::BadRequest("invalid Point handle".into()));
    }

    let handle = escape_html(&user_id.to_lowercase());
    let deep_link = format!(
        "point://add/{}",
        percent_encode_path(&user_id.to_lowercase())
    );
    let deep_link_js =
        serde_json::to_string(&deep_link).expect("serializing a String to JSON cannot fail");
    Ok(Html(format!(
        r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#000000">
  <title>Add {handle} on Point</title>
  <style>
    :root {{ color-scheme: dark; font-family: system-ui, sans-serif; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
      background: #000; color: #f6f6f6; }}
    main {{ width: min(100%, 560px); padding: 32px; border-radius: 16px; background: #0d0d0d; }}
    .brand {{ margin: 0 0 40px; font-size: .78rem; font-weight: 750; letter-spacing: .16em; }}
    h1 {{ margin: 0; font-size: clamp(2rem, 8vw, 3.5rem); line-height: 1; letter-spacing: -.035em; }}
    p {{ max-width: 52ch; color: #b8b8b8; line-height: 1.55; }}
    code {{ color: #f6f6f6; font-size: .95em; overflow-wrap: anywhere; }}
    a {{ min-height: 48px; display: flex; align-items: center; justify-content: center;
      margin-top: 24px; padding: 12px 20px; border-radius: 999px; background: #f6f6f6;
      color: #0a0a0a; font-weight: 700; text-decoration: none; }}
    ol {{ margin: 28px 0 0; padding-left: 22px; color: #b8b8b8; line-height: 1.6; }}
    li + li {{ margin-top: 10px; }}
    @media (prefers-reduced-motion: reduce) {{ *, *::before, *::after {{ scroll-behavior: auto !important; }} }}
  </style>
</head>
<body>
  <main>
    <p class="brand">POINT</p>
    <h1>Add {handle}</h1>
    <p>This invitation carries the full federated handle, so it works even when you and
      <code>{handle}</code> use different Point servers.</p>
    <a href="{deep_link}">Open in Point</a>
    <ol>
      <li>If Point is not installed, install the app first.</li>
      <li>Choose your own Point server and sign in.</li>
      <li>Open <strong>Add a person</strong> and enter <code>{handle}</code>.</li>
    </ol>
  </main>
  <script>window.location.replace({deep_link_js});</script>
</body>
</html>"##
    )))
}

fn is_federated_handle(value: &str) -> bool {
    let mut parts = value.split('@');
    let Some(local) = parts.next() else {
        return false;
    };
    let Some(domain) = parts.next() else {
        return false;
    };
    value.len() <= 254
        && !local.is_empty()
        && !domain.is_empty()
        && parts.next().is_none()
        && !value
            .chars()
            .any(|character| character.is_whitespace() || matches!(character, ':' | '/'))
}

fn percent_encode_path(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'@') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn require_admin(user: &AuthUser) -> ApiResult<()> {
    if user.is_admin {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

#[derive(Deserialize)]
pub struct CreateInviteBody {
    pub max_uses: Option<i32>,
    pub expires_in_hours: Option<i64>,
}

pub async fn create_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateInviteBody>,
) -> ApiResult<Json<Value>> {
    require_admin(&user)?;

    let max_uses = body.max_uses.unwrap_or(1);
    if !(1..=10_000).contains(&max_uses) {
        return Err(AppError::BadRequest("max_uses must be 1-10000".into()));
    }
    let expires_at = match body.expires_in_hours {
        Some(h) if (1..=24 * 365).contains(&h) => Some(Utc::now() + Duration::hours(h)),
        Some(_) => {
            return Err(AppError::BadRequest(
                "expires_in_hours must be 1-8760".into(),
            ))
        }
        None => None,
    };

    let code = generate_invite_code();
    let (id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO invites (code, created_by, max_uses, expires_at) VALUES ($1, $2, $3, $4)
         RETURNING id",
    )
    .bind(&code)
    .bind(&user.user_id)
    .bind(max_uses)
    .bind(expires_at)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(json!({
        "id": id,
        "code": code,
        "max_uses": max_uses,
        "expires_at": expires_at,
    })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct InviteRow {
    pub id: Uuid,
    pub code: String,
    pub created_by: String,
    pub max_uses: i32,
    pub uses: i32,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

pub async fn list_invites(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<InviteRow>>> {
    require_admin(&user)?;
    let invites = sqlx::query_as::<_, InviteRow>(
        "SELECT id, code, created_by, max_uses, uses, expires_at, created_at
         FROM invites ORDER BY created_at DESC",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(invites))
}

pub async fn delete_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    require_admin(&user)?;
    let result = sqlx::query("DELETE FROM invites WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn admin_info(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    require_admin(&user)?;
    let (user_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "domain": state.config.domain,
        "user_count": user_count,
        "open_registration": state.config.open_registration,
    })))
}

/// 8 chars of RFC-4648 base32 — unambiguous, easy to read aloud, 2^40 space.
/// Shared with group invites (api::groups).
pub(crate) fn generate_invite_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

#[cfg(test)]
mod peer_invite_tests {
    use super::*;

    #[tokio::test]
    async fn landing_keeps_the_federated_handle_and_offers_both_paths() {
        let Html(body) = peer_invite_landing(Path("eli@self-hosted.example".into()))
            .await
            .expect("valid landing page");
        assert!(body.contains("point://add/eli@self-hosted.example"));
        assert!(body.contains("Choose your own Point server"));
        assert!(body.contains("Add a person"));
    }

    #[tokio::test]
    async fn landing_escapes_displayed_and_deep_link_content() {
        let Html(body) = peer_invite_landing(Path("eli<test@example.com".into()))
            .await
            .expect("valid escaped landing page");
        assert!(body.contains("eli&lt;test@example.com"));
        assert!(body.contains("point://add/eli%3Ctest@example.com"));
        assert!(!body.contains("eli<test@example.com"));
    }

    #[tokio::test]
    async fn landing_rejects_non_federated_values() {
        assert!(peer_invite_landing(Path("not-a-handle".into()))
            .await
            .is_err());
        assert!(peer_invite_landing(Path("a@b@c".into())).await.is_err());
        assert!(peer_invite_landing(Path("a/b@example.com".into()))
            .await
            .is_err());
    }
}
