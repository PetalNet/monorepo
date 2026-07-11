//! Point home-server: self-hostable, E2E-encrypted (MLS), federatable
//! location sharing. The server relays and stores ciphertext + routing
//! metadata only — it can never read a location.

mod api;
mod auth;
mod authz;
mod config;
mod error;
mod state;
mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use sqlx::postgres::PgPoolOptions;

use crate::config::Config;
use crate::state::AppState;
use crate::ws::hub::Hub;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "point_server=info,tower_http=info".into()),
        )
        .init();

    // Honest boot: this panics loudly on missing/weak JWT_SECRET, DATABASE_URL, DOMAIN.
    let config = Config::from_env();

    // Glitchtip (Sentry-compatible). Must init before the tokio runtime starts.
    let _sentry_guard = config.glitchtip_dsn.as_deref().map(|dsn| {
        sentry::init((
            dsn,
            sentry::ClientOptions {
                release: sentry::release_name!(),
                ..Default::default()
            },
        ))
    });
    if _sentry_guard.is_some() {
        tracing::info!("error reporting enabled (Glitchtip)");
    } else {
        tracing::warn!("GLITCHTIP_DSN not set — error reporting disabled");
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime")
        .block_on(run(config));
}

async fn run(config: Config) {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .expect("failed to connect to Postgres");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("database migration failed");

    let state = AppState {
        pool: pool.clone(),
        config: Arc::new(config.clone()),
        hub: Arc::new(Hub::default()),
    };

    // Periodic cleanup: expired live fixes, expired temp shares, >30d history.
    tokio::spawn(cleanup_task(pool.clone()));

    let app = api::router(state.clone());

    let addr: SocketAddr = config
        .listen
        .parse()
        .unwrap_or_else(|e| panic!("invalid LISTEN address {:?}: {e}", config.listen));
    tracing::info!("point-server listening on http://{addr} (domain {})", config.domain);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind LISTEN address");
    axum::serve(listener, app).await.expect("server error");
}

const HISTORY_RETENTION_DAYS: i32 = 30;

async fn cleanup_task(pool: sqlx::PgPool) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        interval.tick().await;
        let res: Result<(), sqlx::Error> = async {
            sqlx::query(
                "DELETE FROM location_updates
                 WHERE created_at + make_interval(secs => ttl_seconds) < now()",
            )
            .execute(&pool)
            .await?;
            sqlx::query("DELETE FROM temporary_shares WHERE expires_at < now()")
                .execute(&pool)
                .await?;
            sqlx::query("DELETE FROM location_history WHERE created_at < now() - make_interval(days => $1)")
                .bind(HISTORY_RETENTION_DAYS)
                .execute(&pool)
                .await?;
            Ok(())
        }
        .await;
        if let Err(e) = res {
            tracing::error!(error = %e, "cleanup task failed");
        }
    }
}
