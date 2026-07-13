//! Minimal Glitchtip (Sentry store API) error reporting over ureq (DP8).
//!
//! The sentry crate drags tokio+reqwest into a sync binary for what is, for
//! us, one JSON POST. This client implements exactly that: parse the DSN,
//! POST store-API events, install a panic hook. No DSN configured = inert.

use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct Dsn {
    pub public_key: String,
    pub host: String,
    pub scheme: String,
    pub project_id: String,
}

/// Parse `scheme://PUBLIC_KEY@host[:port]/PROJECT_ID`.
pub fn parse_dsn(dsn: &str) -> Result<Dsn, String> {
    let (scheme, rest) = dsn.split_once("://").ok_or("dsn: missing scheme")?;
    let (key, hostpath) = rest.split_once('@').ok_or("dsn: missing public key")?;
    let (host, project_id) = hostpath.rsplit_once('/').ok_or("dsn: missing project id")?;
    if key.is_empty() || host.is_empty() || project_id.is_empty() {
        return Err("dsn: empty component".into());
    }
    Ok(Dsn {
        public_key: key.to_string(),
        host: host.to_string(),
        scheme: scheme.to_string(),
        project_id: project_id.to_string(),
    })
}

static REPORTER: OnceLock<Dsn> = OnceLock::new();

/// Install the global reporter + a panic hook that captures panics as events.
pub fn init(dsn: &str) -> Result<(), String> {
    let parsed = parse_dsn(dsn)?;
    let _ = REPORTER.set(parsed);
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        capture_message(&format!("panic: {info}"), "fatal");
        default_hook(info);
    }));
    Ok(())
}

/// Fire-and-forget event capture; never blocks the caller on failure.
pub fn capture_message(message: &str, level: &str) {
    let Some(dsn) = REPORTER.get() else { return };
    let url = format!(
        "{}://{}/api/{}/store/",
        dsn.scheme, dsn.host, dsn.project_id
    );
    let auth = format!(
        "Sentry sentry_version=7, sentry_client=dispatcher/0.1, sentry_key={}",
        dsn.public_key
    );
    let body = serde_json::json!({
        "event_id": uuid::Uuid::new_v4().simple().to_string(),
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "platform": "other",
        "logger": "dispatcher",
        "level": level,
        "message": message,
        "server_name": std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".into()),
    });
    let message = message.to_string();
    std::thread::spawn(move || {
        let resp = ureq::post(&url)
            .header("X-Sentry-Auth", &auth)
            .header("Content-Type", "application/json")
            .config()
            .timeout_global(Some(std::time::Duration::from_secs(5)))
            .build()
            .send(&body.to_string());
        if let Err(e) = resp {
            eprintln!("glitchtip: failed to report ({message:.60}…): {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsn_parses() {
        let d = parse_dsn("https://abc123@glitchtip.lab.example/42").unwrap();
        assert_eq!(d.public_key, "abc123");
        assert_eq!(d.host, "glitchtip.lab.example");
        assert_eq!(d.project_id, "42");
        assert_eq!(d.scheme, "https");
    }

    #[test]
    fn bad_dsns_are_rejected() {
        assert!(parse_dsn("not-a-dsn").is_err());
        assert!(parse_dsn("https://@host/1").is_err());
        assert!(parse_dsn("https://key@host").is_err());
        assert!(parse_dsn("https://key@/1").is_err());
    }

    #[test]
    fn capture_without_init_is_inert() {
        // Must not panic or block when no DSN was configured.
        capture_message("test", "info");
    }
}
