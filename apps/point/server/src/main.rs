//! Point home-server: self-hostable, E2E-encrypted (MLS), federatable
//! location sharing. The server relays and stores ciphertext + routing
//! metadata only — it can never read a location.

mod api;
mod auth;
mod authz;
mod config;
mod db;
mod error;
mod federation_keys;
mod push;
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

    // Load (or, on first boot, generate + persist) this instance's Ed25519
    // federation signing key. Its public half is published via /.well-known/point.
    let server_signing_key = federation_keys::load_or_generate(&pool)
        .await
        .expect("failed to load/generate the server signing key");

    let state = AppState {
        pool: pool.clone(),
        config: Arc::new(config.clone()),
        hub: Arc::new(Hub::default()),
        server_signing_key: Arc::new(server_signing_key),
    };

    // Periodic cleanup: expired temp shares and >30d history. Current-location
    // rows are one-per-audience last-known snapshots and do not age out.
    tokio::spawn(cleanup_task(state.clone()));

    let app = api::router(state.clone());

    let addr: SocketAddr = config
        .listen
        .parse()
        .unwrap_or_else(|e| panic!("invalid LISTEN address {:?}: {e}", config.listen));
    tracing::info!(
        "point-server listening on http://{addr} (domain {})",
        config.domain
    );
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind LISTEN address");
    // ConnectInfo makes the real peer SocketAddr available to the ClientIp
    // extractor (rate limiting); without it every request would key "unknown".
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("server error");
}

const HISTORY_RETENTION_DAYS: i32 = 30;

async fn cleanup_task(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        interval.tick().await;
        let res: Result<(), sqlx::Error> = async {
            let mut tx = state.pool.begin().await?;
            let expired: Vec<(uuid::Uuid, String, Option<String>)> = sqlx::query_as(
                "DELETE FROM temporary_shares
                 WHERE expires_at < now()
                 RETURNING id, from_user_id, to_user_id",
            )
            .fetch_all(&mut *tx)
            .await?;
            for (_, from_user_id, to_user_id) in &expired {
                let Some(to_user_id) = to_user_id else {
                    continue;
                };
                api::shares::purge_directional_last_known(&mut tx, from_user_id, to_user_id)
                    .await?;
            }
            tx.commit().await?;
            for (id, from_user_id, to_user_id) in expired {
                let Some(to_user_id) = to_user_id else {
                    continue;
                };
                api::shares::notify_temp_teardown(
                    &state,
                    api::shares::TempTeardown::Expired,
                    id,
                    &from_user_id,
                    &to_user_id,
                );
                // Catalog-v0 clients refresh temporary state on this frame.
                let sync = serde_json::json!({ "type": "share.temp_created" }).to_string();
                state.hub.send_to_user(&from_user_id, &sync);
                state.hub.send_to_user(&to_user_id, &sync);
            }
            sqlx::query(
                "DELETE FROM location_history WHERE created_at < now() - make_interval(days => $1)",
            )
            .bind(HISTORY_RETENTION_DAYS)
            .execute(&state.pool)
            .await?;
            // Reap consumed KeyPackages and applied MLS messages so the mailbox
            // and pool tables don't grow without bound (M6). Windows are
            // generous: a late-joining device still finds recent material.
            sqlx::query(
                "DELETE FROM key_packages
                 WHERE consumed_at IS NOT NULL AND consumed_at < now() - make_interval(days => 7)",
            )
            .execute(&state.pool)
            .await?;
            sqlx::query(
                "DELETE FROM mls_messages
                 WHERE processed AND created_at < now() - make_interval(days => 30)",
            )
            .execute(&state.pool)
            .await?;
            Ok(())
        }
        .await;
        if let Err(e) = res {
            tracing::error!(error = %e, "cleanup task failed");
        }
    }
}
