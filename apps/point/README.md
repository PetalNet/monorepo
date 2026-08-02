# Point

**Matrix for location.** Point is a self-hostable, end-to-end-encrypted,
federatable location-sharing network. You run your own home-server, your friends
run theirs (or join yours), and locations are shared over MLS-encrypted groups
that no server — not even yours — can read.

- **Open & self-hosted** — run it yourself, own your data.
- **End-to-end encrypted** — MLS (via the `core` crate), so servers relay
  ciphertext, never plaintext location.
- **Federatable from day one** — home-servers talk to each other, like email or
  Matrix.
- **AGPL-3.0** — self-host copyleft; forks and deployments stay open.

Bridges to Find My / Google / SmartThings are planned for **v2**, not now.

## Repository layout

```text
core/     Lifted OpenMLS E2E crypto crate (reused from legacy point-core).
server/   Rust (axum) home-server + Postgres (sqlx). Plain HTTP behind Traefik.
app/      Implemented Flutter client and its Rust/Flutter bridge.
docs/     Current operations/recovery docs, design records, and legacy maps.
```

## Development

The server and core use the toolchain in `rust-toolchain.toml`. The app pins
Flutter 3.44.6 with Mise:

```sh
cd app
mise install --yes flutter
flutter pub get
flutter analyze
cargo build --manifest-path rust/Cargo.toml --locked --release
LD_LIBRARY_PATH="$PWD/rust/target/release" flutter test
flutter build apk --release
tool/check_version_code.sh
tool/check_apk_libs.sh
```

Run the Rust checks from this directory:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

## Self-host quickstart

Point a DNS record for your domain at a Docker host with ports 80/443 open, then:

```sh
cp .env.example .env
# Set DOMAIN, ACME_EMAIL, JWT_SECRET (openssl rand -hex 32), POSTGRES_PASSWORD.
docker compose up -d
```

The stack pulls the published server image from GHCR and stands up Traefik (with
automatic Let's Encrypt TLS), point-server, and Postgres. Health check:

```sh
curl https://your.domain/health   # -> {"ok":true}
```

Full walkthrough — DNS, TLS, federation, bring-your-own-proxy, backups, upgrades,
account recovery — in [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md). To build
the server from source instead of pulling, add the
`docker-compose.build.yml` override.

## Project records

[`docs/REBUILD.md`](docs/REBUILD.md) records the completed rebuild's framing and
current status. [`DECISIONS.md`](DECISIONS.md) is the chronological engineering
decision log; later entries supersede earlier ones where they conflict.
