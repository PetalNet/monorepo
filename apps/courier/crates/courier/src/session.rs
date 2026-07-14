//! Login, session persistence, and store self-healing.
//!
//! Establishing a session is fully self-recovering:
//!
//! - a stored session is validated with `whoami` BEFORE handlers install; an
//!   invalid token triggers a fresh login (re-using the old device id so
//!   E2EE identity is preserved);
//! - a crypto-store/account mismatch clears the local store and retries;
//! - `MATRIX_RECOVERY_KEY` (if set) recovers encryption secrets and room
//!   keys after login.

use std::{
    fs,
    io::IsTerminal as _,
    path::{Path, PathBuf},
};

use anyhow::{Context as _, Result, anyhow};
use matrix_sdk::{
    Client, HttpError, SessionMeta,
    authentication::{SessionTokens, matrix::MatrixSession},
};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::args::Args;

#[derive(Debug, Serialize, Deserialize)]
struct SavedSession {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    user_id: String,
    device_id: String,
}

/// Build a client and establish a working session (restore or login),
/// including token validation and store recovery.
///
/// # Errors
///
/// Returns an error when no working session can be established (bad
/// credentials, unreachable homeserver, unusable store).
pub async fn establish(args: &Args) -> Result<Client> {
    let mut client = build_client(args).await?;

    // Restore session if available; otherwise login.
    let (restored_from_session, restored_device_id) =
        if let Some(session) = load_session(&args.session_file)? {
            info!("Restoring session for {}", session.user_id);
            let session_device_id = session.device_id.clone();
            let matrix_session = MatrixSession {
                meta: SessionMeta {
                    user_id: session.user_id.parse().context("invalid stored user_id")?,
                    device_id: session.device_id.into(),
                },
                tokens: SessionTokens {
                    access_token: session.access_token,
                    refresh_token: session.refresh_token,
                },
            };
            client
                .restore_session(matrix_session)
                .await
                .context("restoring session")?;
            (true, Some(session_device_id))
        } else {
            let password = resolve_password(
                args.password.as_deref(),
                &args.session_file,
                "No MATRIX_PASSWORD provided and no stored session",
            )?;
            login_with_store_recovery(&mut client, args, &password, None).await?;
            (false, None)
        };

    // Validate restored session before installing handlers/syncing.
    if restored_from_session {
        match client.whoami().await {
            Ok(_) => {}
            Err(error) if is_unknown_token_http_error(&error) => {
                warn!(
                    error = %error,
                    "Stored session token is invalid; attempting fresh login"
                );
                let password = resolve_password(
                    args.password.as_deref(),
                    &args.session_file,
                    "Stored session is invalid and re-login is required",
                )?;
                client = build_client(args).await?;
                login_with_store_recovery(
                    &mut client,
                    args,
                    &password,
                    restored_device_id.as_deref(),
                )
                .await
                .context("re-login failed after invalid stored session")?;
            }
            Err(error) => return Err(anyhow!("session validation failed: {error}")),
        }
    }

    // If MATRIX_RECOVERY_KEY is set, use it to recover encryption secrets
    // and download room keys.
    if let Ok(recovery_key) = std::env::var("MATRIX_RECOVERY_KEY") {
        let recovery_key = recovery_key.trim().to_owned();
        if !recovery_key.is_empty() {
            info!("Recovery key provided; attempting to recover encryption secrets...");
            match client.encryption().recovery().recover(&recovery_key).await {
                Ok(()) => info!("Recovery successful — encryption secrets and room keys restored"),
                Err(e) => warn!(error = %e, "Recovery failed; continuing without it"),
            }
        }
    }

    Ok(client)
}

async fn build_client(args: &Args) -> Result<Client> {
    Client::builder()
        .homeserver_url(&args.homeserver)
        .handle_refresh_tokens()
        .sqlite_store(&args.store, None)
        .build()
        .await
        .context("building matrix client")
}

fn load_session(path: &PathBuf) -> Result<Option<SavedSession>> {
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(path)
        .with_context(|| format!("reading session file at {}", path.display()))?;
    let session: SavedSession = serde_json::from_str(&data).context("parsing session JSON")?;
    Ok(Some(session))
}

fn save_session(path: &PathBuf, session: &SavedSession) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(session)?;
    fs::write(path, data).with_context(|| format!("writing session file at {}", path.display()))?;
    Ok(())
}

fn resolve_password(
    password_opt: Option<&str>,
    session_file: &Path,
    missing_password_reason: &str,
) -> Result<String> {
    if let Some(password) = password_opt.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(password.to_owned());
    }
    if !std::io::stdin().is_terminal() {
        return Err(anyhow!(
            "{missing_password_reason}. In Docker/non-interactive mode, set MATRIX_PASSWORD env (session file: {})",
            session_file.display()
        ));
    }
    warn!("No password provided via --password or MATRIX_PASSWORD. Prompting...");
    #[cfg(feature = "rpassword")]
    {
        rpassword::prompt_password("Matrix password:")
            .map_err(|e| anyhow!("Failed to read password: {e}"))
    }
    #[cfg(not(feature = "rpassword"))]
    {
        let _ = session_file;
        Err(anyhow!(
            "rpassword feature is not enabled. Cannot prompt for password."
        ))
    }
}

async fn login_with_store_recovery(
    client: &mut Client,
    args: &Args,
    password: &str,
    preferred_device_id: Option<&str>,
) -> Result<()> {
    match login_and_store_session(client, args, password, preferred_device_id).await {
        Ok(()) => Ok(()),
        Err(error) if is_crypto_store_account_mismatch(&error) => {
            warn!(
                store = %args.store.display(),
                "Crypto store account/device mismatch; clearing local store and retrying login"
            );
            clear_store_dir(&args.store)?;
            *client = build_client(args).await?;
            login_and_store_session(client, args, password, preferred_device_id)
                .await
                .context("login failed after resetting crypto store")
        }
        Err(error) => Err(error),
    }
}

async fn login_and_store_session(
    client: &Client,
    args: &Args,
    password: &str,
    preferred_device_id: Option<&str>,
) -> Result<()> {
    info!("Logging in as {}", args.username);
    let mut login_builder = client
        .matrix_auth()
        .login_username(&args.username, password)
        .initial_device_display_name(&args.device_name)
        .request_refresh_token();
    if let Some(device_id) = preferred_device_id {
        login_builder = login_builder.device_id(device_id);
    }
    let response = login_builder.send().await.context("login failed")?;

    let session = SavedSession {
        access_token: response.access_token.clone(),
        refresh_token: response.refresh_token.clone(),
        user_id: response.user_id.to_string(),
        device_id: response.device_id.to_string(),
    };
    save_session(&args.session_file, &session)?;
    info!(
        "Logged in: user={} device={}",
        session.user_id, session.device_id
    );
    Ok(())
}

fn is_unknown_token_http_error(error: &HttpError) -> bool {
    use matrix_sdk::ruma::api::client::error::ErrorKind;

    matches!(
        error.client_api_error_kind(),
        Some(ErrorKind::UnknownToken { .. })
    )
}

fn is_crypto_store_account_mismatch(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .to_string()
            .contains("account in the store doesn't match the account in the constructor")
    })
}

fn clear_store_dir(store: &PathBuf) -> Result<()> {
    if store.exists() {
        fs::remove_dir_all(store)
            .with_context(|| format!("clearing store directory at {}", store.display()))?;
    }
    fs::create_dir_all(store)
        .with_context(|| format!("recreating store directory at {}", store.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_round_trips_through_disk() {
        let path =
            std::env::temp_dir().join(format!("courier-session-test-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);
        let session = SavedSession {
            access_token: "tok".to_owned(),
            refresh_token: Some("ref".to_owned()),
            user_id: "@bot:hs".to_owned(),
            device_id: "DEV".to_owned(),
        };
        save_session(&path, &session).expect("save");
        let loaded = load_session(&path).expect("load").expect("present");
        assert_eq!(loaded.access_token, "tok");
        assert_eq!(loaded.refresh_token.as_deref(), Some("ref"));
        assert_eq!(loaded.user_id, "@bot:hs");
        assert_eq!(loaded.device_id, "DEV");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn missing_session_file_is_none() {
        let path = PathBuf::from("/nonexistent/courier-session.json");
        assert!(load_session(&path).expect("ok").is_none());
    }
}
