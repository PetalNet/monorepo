//! Server configuration, loaded from the environment. Honest boot: the server
//! refuses to start on a missing/weak JWT_SECRET rather than limping insecurely.

use std::env;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub listen: String,
    pub jwt_secret: String,
    /// Public domain this home-server federates under; the `@domain` suffix of
    /// every local user id.
    pub domain: String,
    /// This instance's own public https base (env `PUBLIC_URL`), e.g.
    /// `https://point.example.org`. Advertised in `/.well-known/point` so peers
    /// know where to POST our inbox. Defaults to `https://{domain}` if unset.
    pub public_url: String,
    /// Escape hatch for the cross-instance integration test: when true, the
    /// outbound S2S SSRF guard is skipped and S2S uses plain http (so a peer at
    /// `127.0.0.1:PORT` is reachable). Default false — NEVER enable in prod
    /// (env `FEDERATION_ALLOW_PRIVATE`).
    pub federation_allow_private: bool,
    pub open_registration: bool,
    /// Public URL TEMPLATE of this instance's own tileserver (self-hosted OSM
    /// tier), e.g. `https://tiles.example.org/styles/point-dark/{z}/{x}/{y}.png`.
    /// Advertised in `/.well-known/point` as `endpoints.tiles`; the app uses it
    /// for the max-private map. Unset = this instance runs no tileserver (env
    /// `TILES_URL`).
    pub tiles_url: Option<String>,
    /// Upstream tile URL TEMPLATE for the proxied tier (env `TILE_UPSTREAM`),
    /// e.g. a Stadia/Protomaps URL with the API key baked in. The server
    /// fetches tiles from it on the client's behalf so the provider only ever
    /// sees this server. Unset = the proxied tier is unavailable here.
    pub tile_upstream: Option<String>,
    /// Trust reverse-proxy client-IP headers (`X-Real-IP`). Off by default: a
    /// directly-exposed server must ignore attacker-spoofable headers and key
    /// rate limits on the real peer address. Set only behind a proxy that
    /// overwrites the header (env `TRUST_PROXY_HEADERS`).
    pub trusted_proxy: bool,
    /// Optional Glitchtip/Sentry DSN. Absent = error reporting disabled.
    pub glitchtip_dsn: Option<String>,
    /// Optional OIDC provider (decision 17). Off unless OIDC_ENABLED=true.
    pub oidc: Option<OidcConfig>,
}

#[derive(Clone)]
pub struct OidcConfig {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    /// Public base URL of this server, used to build the redirect URI.
    pub public_url: String,
}

impl Config {
    /// Load from env. Panics with a clear message on invalid security-critical
    /// config — an unbootable server beats a silently insecure one.
    pub fn from_env() -> Self {
        let jwt_secret = env::var("JWT_SECRET").expect(
            "JWT_SECRET must be set (generate 32+ random chars, e.g. `openssl rand -hex 32`)",
        );
        assert!(
            jwt_secret.len() >= 32,
            "JWT_SECRET must be at least 32 characters (got {}); refusing to boot",
            jwt_secret.len()
        );

        let database_url =
            env::var("DATABASE_URL").expect("DATABASE_URL must be set (postgres://...)");
        let domain = env::var("DOMAIN").expect(
            "DOMAIN must be set (the public domain of this home-server, e.g. point.example.org)",
        );
        assert!(
            !domain.is_empty() && !domain.contains('@') && !domain.contains('/'),
            "DOMAIN must be a bare hostname (got {domain:?})"
        );

        let oidc = if env_bool("OIDC_ENABLED", false) {
            Some(OidcConfig {
                issuer: env::var("OIDC_ISSUER").expect("OIDC_ENABLED=true requires OIDC_ISSUER"),
                client_id: env::var("OIDC_CLIENT_ID")
                    .expect("OIDC_ENABLED=true requires OIDC_CLIENT_ID"),
                client_secret: env::var("OIDC_CLIENT_SECRET")
                    .expect("OIDC_ENABLED=true requires OIDC_CLIENT_SECRET"),
                public_url: env::var("PUBLIC_URL").expect(
                    "OIDC_ENABLED=true requires PUBLIC_URL (e.g. https://point.example.org)",
                ),
            })
        } else {
            None
        };

        let public_url = env::var("PUBLIC_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("https://{domain}"));

        Self {
            database_url,
            listen: env::var("LISTEN").unwrap_or_else(|_| "0.0.0.0:8330".to_string()),
            jwt_secret,
            domain,
            public_url,
            federation_allow_private: env_bool("FEDERATION_ALLOW_PRIVATE", false),
            open_registration: env_bool("OPEN_REGISTRATION", false),
            tiles_url: std::env::var("TILES_URL").ok().filter(|v| !v.is_empty()),
            tile_upstream: std::env::var("TILE_UPSTREAM")
                .ok()
                .filter(|v| !v.is_empty()),
            trusted_proxy: env_bool("TRUST_PROXY_HEADERS", false),
            glitchtip_dsn: env::var("GLITCHTIP_DSN").ok().filter(|s| !s.is_empty()),
            oidc,
        }
    }
}

fn env_bool(key: &str, default: bool) -> bool {
    match env::var(key) {
        Ok(v) => matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        Err(_) => default,
    }
}
