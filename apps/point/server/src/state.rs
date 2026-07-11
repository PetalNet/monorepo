//! Shared application state.

use sqlx::PgPool;
use std::sync::Arc;

use crate::config::Config;
use crate::ws::hub::Hub;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub hub: Arc<Hub>,
}
