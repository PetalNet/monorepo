//! Shared application state.

use ed25519_dalek::SigningKey;
use sqlx::PgPool;
use std::sync::Arc;

use crate::config::Config;
use crate::ws::hub::Hub;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub hub: Arc<Hub>,
    /// This instance's Ed25519 signing key (M3 federation), loaded/generated on
    /// boot from `server_keys`. Signs outbound S2S bodies; its public half is
    /// published via `/.well-known/point`. Never logged.
    pub server_signing_key: Arc<SigningKey>,
}
