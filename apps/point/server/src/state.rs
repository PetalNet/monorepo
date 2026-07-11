//! Shared application state.

use sqlx::PgPool;
use std::sync::Arc;

use crate::config::Config;
use crate::ws::hub::Hub;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    // Read by the WS/location wave (M0 wave B).
    #[allow(dead_code)]
    pub hub: Arc<Hub>,
}
