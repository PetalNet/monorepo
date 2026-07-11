# Multi-stage build for the Point home-server.
# Build context must be the repo ROOT (see docker-compose.yml) so the full Cargo
# workspace — root Cargo.toml, core/ (lifted MLS crate), and server/ — is present.
FROM rust:1-bookworm AS build
WORKDIR /build
COPY Cargo.toml ./
COPY core/ core/
COPY server/ server/
RUN cargo build --release --bin point-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/point-server /usr/local/bin/point-server
EXPOSE 8330
ENTRYPOINT ["point-server"]
