//! Optional OIDC login (decision 17). Routes are registered only when
//! `config.oidc` is set; without it these handlers don't exist (404).
//!
//! Flow: `/api/oidc/login` stashes state+nonce+PKCE verifier in a short-lived
//! HttpOnly cookie and 302s to the IdP; `/api/oidc/callback` verifies state,
//! exchanges the code, verifies the id_token (issuer/audience/nonce via the
//! openidconnect crate), maps `preferred_username` (fallback `sub`) onto our
//! username rules, provisions the account on first login (password_hash NULL,
//! so password login stays impossible for it), and returns our local JWT as
//! JSON — the mobile app drives this in a custom tab.

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use openidconnect::core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata};
use openidconnect::{
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointMaybeSet, EndpointNotSet,
    EndpointSet, IssuerUrl, Nonce, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope,
    TokenResponse,
};
use serde::Deserialize;
use serde_json::json;

use crate::auth;
use crate::config::OidcConfig;
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

use super::auth::{map_oidc_username, USER_CREATE_LOCK_KEY};

const COOKIE_NAME: &str = "point_oidc";
/// The state/nonce/PKCE cookie only needs to survive one IdP round-trip.
const COOKIE_MAX_AGE_SECS: u32 = 600;

type HttpClient = openidconnect::reqwest::Client;
type OidcClient = CoreClient<
    EndpointSet,      // auth url (required in discovery)
    EndpointNotSet,   // device auth
    EndpointNotSet,   // introspection
    EndpointNotSet,   // revocation
    EndpointMaybeSet, // token
    EndpointMaybeSet, // userinfo
>;

pub async fn login(State(state): State<AppState>) -> ApiResult<Response> {
    let cfg = state.config.oidc.as_ref().ok_or(AppError::NotFound)?;
    let http = http_client()?;
    let client = discover_client(cfg, &http).await?;

    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
    let (auth_url, csrf_state, nonce) = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        // `openid` is added by the crate; we want the profile claims too.
        .add_scope(Scope::new("profile".to_string()))
        .set_pkce_challenge(pkce_challenge)
        .url();

    // Values are URL-safe base64 (no '.', no ';'), so the joint encoding is
    // unambiguous. HttpOnly+Secure+Lax: readable only by us, sent on the
    // top-level redirect back from the IdP.
    let cookie = format!(
        "{COOKIE_NAME}={}.{}.{}; Path=/api/oidc; Max-Age={COOKIE_MAX_AGE_SECS}; HttpOnly; Secure; SameSite=Lax",
        csrf_state.secret(),
        nonce.secret(),
        pkce_verifier.secret(),
    );
    Ok((
        StatusCode::FOUND,
        [
            (header::LOCATION, auth_url.to_string()),
            (header::SET_COOKIE, cookie),
        ],
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: String,
    pub state: String,
}

pub async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> ApiResult<Response> {
    let cfg = state.config.oidc.as_ref().ok_or(AppError::NotFound)?;

    let (cookie_state, nonce, pkce_verifier) =
        read_flow_cookie(&headers).ok_or_else(|| oidc_err("cookie", "missing flow cookie"))?;
    if query.state != cookie_state {
        return Err(oidc_err("state", "state mismatch"));
    }

    let http = http_client()?;
    let client = discover_client(cfg, &http).await?;
    let tokens = client
        .exchange_code(AuthorizationCode::new(query.code))
        .map_err(|e| oidc_err("token endpoint", e))?
        .set_pkce_verifier(PkceCodeVerifier::new(pkce_verifier))
        .request_async(&http)
        .await
        .map_err(|e| oidc_err("code exchange", e))?;
    let id_token = tokens
        .id_token()
        .ok_or_else(|| oidc_err("id_token", "provider returned no id_token"))?;
    let claims = id_token
        .claims(&client.id_token_verifier(), &Nonce::new(nonce))
        .map_err(|e| oidc_err("id_token verify", e))?;

    let raw_username = claims
        .preferred_username()
        .map(|u| u.as_str().to_string())
        .unwrap_or_else(|| claims.subject().as_str().to_string());
    let username = map_oidc_username(&raw_username)?;
    let user_id = format!("{username}@{}", state.config.domain);

    let row: Option<(String, bool, bool)> =
        sqlx::query_as("SELECT display_name, is_admin, is_federated FROM users WHERE id = $1")
            .bind(&user_id)
            .fetch_optional(&state.pool)
            .await?;
    let (display_name, is_admin) = match row {
        // A federated shadow is another server's user; it can never log in here.
        Some((_, _, true)) => return Err(AppError::Unauthorized),
        Some((display_name, is_admin, false)) => (display_name, is_admin),
        None => {
            // First login provisions the account, same shape as /api/register
            // but with no password hash. Same first-user-admin bootstrap rule.
            let mut tx = state.pool.begin().await?;
            sqlx::query("SELECT pg_advisory_xact_lock($1)")
                .bind(USER_CREATE_LOCK_KEY)
                .execute(&mut *tx)
                .await?;
            let (user_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
                .fetch_one(&mut *tx)
                .await?;
            let is_first_user = user_count == 0;
            db::users::create_local_user(
                &mut tx,
                &user_id,
                &username,
                None,
                is_first_user,
                "primary",
            )
            .await?;
            tx.commit().await?;
            (username, is_first_user)
        }
    };

    let token = auth::create_token(&state.config.jwt_secret, &user_id, is_admin)?;
    let clear_cookie =
        format!("{COOKIE_NAME}=; Path=/api/oidc; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    Ok((
        StatusCode::OK,
        [(header::SET_COOKIE, clear_cookie)],
        Json(json!({
            "token": token,
            "user_id": user_id,
            "display_name": display_name,
            "is_admin": is_admin,
        })),
    )
        .into_response())
}

fn http_client() -> Result<HttpClient, AppError> {
    openidconnect::reqwest::ClientBuilder::new()
        // Redirect-following on IdP responses is an SSRF vector; the flow
        // never needs it (openidconnect docs recommend disabling).
        .redirect(openidconnect::reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::Internal(format!("oidc http client: {e}")))
}

async fn discover_client(cfg: &OidcConfig, http: &HttpClient) -> Result<OidcClient, AppError> {
    let issuer = IssuerUrl::new(cfg.issuer.clone()).map_err(|e| oidc_err("issuer url", e))?;
    let metadata = CoreProviderMetadata::discover_async(issuer, http)
        .await
        .map_err(|e| oidc_err("discovery", e))?;
    let redirect = RedirectUrl::new(format!(
        "{}/api/oidc/callback",
        cfg.public_url.trim_end_matches('/')
    ))
    .map_err(|e| oidc_err("redirect url", e))?;
    Ok(CoreClient::from_provider_metadata(
        metadata,
        ClientId::new(cfg.client_id.clone()),
        Some(ClientSecret::new(cfg.client_secret.clone())),
    )
    .set_redirect_uri(redirect))
}

fn read_flow_cookie(headers: &HeaderMap) -> Option<(String, String, String)> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    let value = cookies
        .split(';')
        .map(str::trim)
        .find_map(|c| c.strip_prefix("point_oidc="))?;
    let mut parts = value.splitn(3, '.');
    Some((
        parts.next()?.to_string(),
        parts.next()?.to_string(),
        parts.next()?.to_string(),
    ))
}

/// Uniform client-facing failure; the stage + cause go to logs only (never
/// codes or tokens — `e` here is always an error, not a credential).
fn oidc_err(stage: &str, e: impl std::fmt::Display) -> AppError {
    tracing::warn!(stage, error = %e, "oidc flow failed");
    AppError::BadRequest("oidc login failed".into())
}
