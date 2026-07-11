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
    pub open_registration: bool,
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

        Self {
            database_url,
            listen: env::var("LISTEN").unwrap_or_else(|_| "0.0.0.0:8330".to_string()),
            jwt_secret,
            domain,
            open_registration: env_bool("OPEN_REGISTRATION", false),
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
