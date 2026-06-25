# Matrix Ping Bot (Rust)

Simple Matrix bot using the Matrix Rust SDK with end‑to‑end encryption enabled. It joins rooms (unless disabled), relays messages between configured room clusters, and replies "pong" to messages containing `!ping`.

## Features

- E2EE enabled with persistent SQLite store
- Session restore (no need to log in every run)
- Auto‑join on invites (toggle with `--no-autojoin`)
- Room cluster relaying between room IDs/aliases

## Requirements

- Rust toolchain via rustup
- OpenSSL (macOS: `brew install openssl@3` if needed by dependencies)

## Build

```sh
cargo build --release
```

## Check

```sh
cargo fmt && cargo clippy
```


## Run

You can use flags or environment variables.

### Env file (.env)

- Copy `.env.example` to `.env` and fill values.
- The app auto-loads `.env` and clap reads `MATRIX_*` vars.
- Flags still override env values if both are set.

#### Example `.env`

```properties
MATRIX_HOMESERVER=https://matrix-client.matrix.org
MATRIX_USERNAME=your_bot_user
MATRIX_PASSWORD=yourpassword
MATRIX_STORE=./bot-store
MATRIX_SESSION_FILE=./session.json
MATRIX_DEVICE_NAME=matrix-ping-bot
MATRIX_CONFIG=./config.yaml
```

### Flags

```sh
cargo run -- \
  --homeserver https://matrix-client.matrix.org \
  --username your_bot_user \
  --password 'yourpassword' \
  --store ./bot-store \
  --session-file ./session.json \
  --device-name "matrix-ping-bot" \
  --config ./config.yaml
```

### Environment variables (flags override env)

- `MATRIX_HOMESERVER`
- `MATRIX_USERNAME`
- `MATRIX_PASSWORD`
- `MATRIX_STORE` (default `./bot-store`)
- `MATRIX_SESSION_FILE` (default `./session.json`)
- `MATRIX_DEVICE_NAME` (default `matrix-ping-bot`)

#### Example

```sh
MATRIX_HOMESERVER=https://matrix-client.matrix.org \
MATRIX_USERNAME=your_bot_user \
MATRIX_PASSWORD=yourpassword \
cargo run --release
```

### Cluster Config (YAML)

- Copy `config.example.yaml` to `config.yaml` and edit.
- Each cluster lists room IDs (`!room:server`) or aliases (`#alias:server`). Messages in one room are forwarded to others in the same cluster as `DisplayName: message`.

#### Example `config.yaml`

```yaml
clusters:
  - name: sample-pair
    rooms:
      - "!roomIdA:example.org"
      - "!roomIdB:example.org"
```

## Usage Notes

- The first run logs in and stores a session JSON and an encrypted store in `--store`.
- Subsequent runs reuse the stored session; you can delete `session.json` to force re-login.
- Invite the bot to a room. It auto‑joins unless `--no-autojoin` is set.
- Send `!ping` in the room; the bot replies with `pong`.
- Ensure the bot is joined to all rooms in your cluster(s) to enable relaying.

## Git Hygiene

- Do not commit secrets. `.gitignore` ignores `.env`, `config.yaml`, the E2EE store, and session.
- Create local files from examples:
  - `cp .env.example .env`
  - `cp config.example.yaml config.yaml`

## Troubleshooting

- If compilation fails due to SSL on macOS: `export OPENSSL_DIR=$(brew --prefix openssl@3)` before building.
- To rotate devices/sessions, remove `session.json` and the store directory.

## Security

- E2EE is enabled; device verification is optional for bots but recommended in sensitive rooms.
- Store directory contains encryption keys; keep it private and backed up if persistence is desired.

## Deploy

- Docker (build + run):
  - Build: `docker build -t matrix-ping-bot:local .`
  - Run:
  ```sh
  docker run --rm -it \
    -e MATRIX_HOMESERVER=... \
    -e MATRIX_USERNAME=... \
    -e MATRIX_PASSWORD=... \
    -e MATRIX_CONFIG=/app/config.yaml \
    -v $(pwd)/config.yaml:/app/config.yaml:ro \
    -v $(pwd)/data:/data \
    matrix-ping-bot:local
  ```
- Docker Compose:
  - Put secrets in `.env` next to `docker-compose.yml` (MATRIX\_\* vars).
  - `docker compose up -d --build`
  - Data persists in `matrix-ping-bot/data/` (session + store).
- systemd service (bare metal):
  - Install binary: `cargo build --release` then copy `target/release/matrix-ping-bot` to `/opt/matrix-ping-bot/`.
  - Create a service user: `sudo useradd -r -m matrixbot` and chown `/opt/matrix-ping-bot`.
  - Copy `matrix-ping-bot.service.example` to `/etc/systemd/system/matrix-ping-bot.service` and edit paths as needed.
  - Create `/etc/matrix-ping-bot.env` with e.g. `MATRIX_HOMESERVER=...`, `MATRIX_USERNAME=...`, `MATRIX_PASSWORD=...`.
  - `sudo systemctl daemon-reload && sudo systemctl enable --now matrix-ping-bot`.
