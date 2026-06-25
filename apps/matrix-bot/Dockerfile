# Stage 1: Build application
FROM rustlang/rust:nightly AS builder
WORKDIR /usr/src/app

# Copy source and build
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN cargo build --release --bin matrix-ping-bot

# Stage 2: Runtime (use sid to match glibc from nightly builder)
FROM debian:sid-slim

# Install Node 20 from NodeSource (MCP packages need Node >= 20)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    curl \
    gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Rust Binary
COPY --from=builder /usr/src/app/target/release/matrix-ping-bot /usr/local/bin/matrix-ping-bot

# Create app user with home directory (needed for npm) and data directory
RUN mkdir -p /data && \
    useradd -r -u 10001 -m -d /home/app app && \
    chown -R app:app /data /app /home/app

USER app

ENV RUST_LOG=info,plugin_ai=debug \
    MATRIX_STORE=/app/data/store \
    MATRIX_SESSION_FILE=/app/data/session.json

ENTRYPOINT ["matrix-ping-bot"]
