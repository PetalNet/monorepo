//! Point server — minimal axum + Postgres skeleton.
//!
//! Point is a self-hostable, E2E-encrypted, federatable location-sharing network
//! ("Matrix for location"). This binary is the home-server: it terminates plain
//! HTTP (Traefik terminates TLS in front of it), speaks to a single Postgres
//! (PostGIS-ready) database, and exposes the federation + client APIs. This
//! initial skeleton only serves `/health`; the real surface lands in later
//! wayfinder tickets.

use std::env;
use std::net::SocketAddr;

use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() {
    // Fail fast on a weak or missing signing secret — a short JWT secret is a
    // silent security hole, so we refuse to boot without a real one.
    let jwt_secret = env::var("JWT_SECRET")
        .expect("JWT_SECRET must be set (generate 32+ random chars)");
    if jwt_secret.len() < 32 {
        panic!("JWT_SECRET must be at least 32 characters (got {})", jwt_secret.len());
    }

    let database_url =
        env::var("DATABASE_URL").expect("DATABASE_URL must be set (postgres://...)");

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .expect("failed to connect to Postgres");

    let app = Router::new()
        .route("/health", get(health))
        .with_state(pool);

    let listen = env::var("LISTEN").unwrap_or_else(|_| "0.0.0.0:8330".to_string());
    let addr: SocketAddr = listen
        .parse()
        .unwrap_or_else(|e| panic!("invalid LISTEN address {listen:?}: {e}"));

    println!("point-server listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind LISTEN address");
    axum::serve(listener, app)
        .await
        .expect("server error");
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}
