# Stage 1: build
FROM rust:1.90 AS builder
WORKDIR /usr/src/app

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
RUN cargo build --release --bin courier

# Stage 2: runtime
FROM debian:bookworm-slim

# Node 20 from NodeSource (MCP packages need Node >= 20)
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

COPY --from=builder /usr/src/app/target/release/courier /usr/local/bin/courier

RUN mkdir -p /data && \
    useradd -r -u 10001 -m -d /home/app app && \
    chown -R app:app /data /app /home/app

USER app

ENV RUST_LOG=info,courier_ai=debug \
    MATRIX_STORE=/app/data/store \
    MATRIX_SESSION_FILE=/app/data/session.json

ENTRYPOINT ["courier"]
