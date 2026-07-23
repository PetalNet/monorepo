# Multi-stage build for the Point home-server.
# Build context must be the repo ROOT (see docker-compose.yml) so the full Cargo
# workspace — root Cargo.toml, core/ (lifted MLS crate), and server/ — is present.
FROM rust:1.96-bookworm@sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663 AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY core/ core/
COPY server/ server/
RUN cargo build --release --locked --bin point-server

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/point-server /usr/local/bin/point-server
EXPOSE 8330
ENTRYPOINT ["point-server"]
