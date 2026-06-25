# Matrix Ping Bot

Simple Matrix bot using the Matrix Rust SDK with end‑to‑end encryption enabled. It joins rooms (unless disabled), relays messages between configured room clusters, and replies "pong" to messages containing `!ping`.

## Features

- E2EE enabled with persistent SQLite store
- Session restore (no need to log in every run)
- Auto‑join on invites (toggle with `--no-autojoin`)
- Room cluster relaying between room IDs/aliases

## Requirements

- Rust
