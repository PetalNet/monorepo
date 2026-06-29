use tracing::{Subscriber, level_filters::LevelFilter};
use tracing_subscriber::{
    EnvFilter, Layer, layer::SubscriberExt as _, registry::LookupSpan, util::SubscriberInitExt as _,
};

pub enum LogFormat {
    Json,
    Pretty,
}

impl LogFormat {
    pub fn layer<S>(self) -> Box<dyn Layer<S> + Send + Sync + 'static>
    where
        for<'a> S: Subscriber + LookupSpan<'a>,
    {
        // Shared configuration regardless of where logs are output to.
        let fmt = tracing_subscriber::fmt::layer().with_thread_names(true);

        // Configure the writer based on the desired log target:
        match self {
            Self::Json => Box::new(fmt.json().with_target(false)),
            Self::Pretty => Box::new(
                fmt.pretty()
                    .with_target(true)
                    .with_file(true)
                    .with_line_number(true),
            ),
        }
    }
}

pub fn init_tracing() {
    let log_mode = std::env::var("RUST_LOG_MODE").unwrap_or_else(|_| "pretty".into());

    // Build filter with quieter matrix-sdk crates to reduce spam
    let filter = EnvFilter::builder()
        .with_default_directive(LevelFilter::INFO.into())
        .from_env()
        .unwrap()
        // Silence noisy crypto warnings about forwarded keys and decryption errors
        .add_directive("matrix_sdk_crypto::gossiping=error".parse().unwrap())
        .add_directive("matrix_sdk_crypto::olm=error".parse().unwrap())
        .add_directive("matrix_sdk_crypto::session_manager=error".parse().unwrap())
        .add_directive("matrix_sdk_crypto::machine=error".parse().unwrap())
        // Reduce base SDK sync spam
        .add_directive("matrix_sdk_base::client=warn".parse().unwrap())
        // Keep our bot and plugin logs at INFO
        .add_directive("matrix_ping_bot=info".parse().unwrap())
        .add_directive("plugin_ai=debug".parse().unwrap());

    let log_mode = match log_mode.as_str() {
        "json" => LogFormat::Json,
        _ => LogFormat::Pretty,
    };

    tracing_subscriber::registry()
        .with(filter)
        .with(log_mode.layer())
        .init();
}
