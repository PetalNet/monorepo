# Zero-knowledge account recovery

Point is end-to-end encrypted, which creates a hard problem: a user's MLS
identity and group state live **on the device**. Lose the phone and — without
recovery — you lose every share you're part of, permanently. Point solves this
without weakening the E2E guarantee: the home-server stores an **encrypted
backup of the MLS state that it cannot decrypt**.

## The guarantee

- The backup is encrypted **on the device** under a key derived from a
  **recovery code** the user holds. The server stores opaque ciphertext plus
  nothing it can use to open it.
- The server never sees the recovery code, the derived key, or the plaintext
  state. Compromising the server (or its database backups) yields ciphertext
  only.
- A wrong recovery code, or a tampered blob, fails closed — it never yields a
  partial or wrong state.

## How it works

**Enrollment (on the device).** The client generates a 120-bit recovery code —
24 Crockford-base32 symbols, grouped `XXXXXX-XXXXXX-XXXXXX-XXXXXX` — and shows it
to the user once. It derives a key from the code with **Argon2id** (m=64 MiB,
t=3, p=1) over a random 16-byte salt, encrypts the exported MLS state with
**XChaCha20-Poly1305**, and uploads the blob:

```
blob = MAGIC(4) ‖ salt(16) ‖ nonce(24) ‖ XChaCha20-Poly1305(state)
```

The server stores it verbatim in `mls_backups`, one row per user, keyed to the
authenticated account.

**Refresh.** MLS state advances as groups change and the ratchet turns. The
device caches the recovery code in platform secure storage (Keystore/Keychain)
so it can re-encrypt and re-upload after state changes. This adds no exposure the
device doesn't already have — the plaintext MLS state itself lives in the same
secure storage, so a device compromise already loses everything the code
protects. The point of "zero-knowledge" is that the **server** never learns the
code, and it never does.

**Recovery (on a new device).** The user signs in normally (password or SSO),
then enters their recovery code. The client fetches the blob, derives the key,
decrypts, and restores the MLS identity locally — after which it can decrypt the
groups it was a member of. No code, no recovery: the server genuinely cannot
help, by design.

## What the operator sees

Nothing sensitive. As the server operator you store ciphertext in one Postgres
table and keep Postgres backed up (see [SELF-HOSTING.md](SELF-HOSTING.md)). You
cannot read users' state and you cannot recover an account on a user's behalf —
that authority rests entirely with the person holding the recovery code.

## Where it lives

- Crypto: `core/src/recovery.rs` (`point_core::recovery`) — Argon2id + XChaCha20,
  unit-tested (roundtrip, wrong-code, tamper, no-plaintext-leak).
- Server: `server/src/api/recovery.rs` + migration `0003_recovery.sql` —
  ciphertext-only `PUT`/`GET`/`DELETE /api/recovery/backup`, scoped to the
  authenticated user, integration-tested for per-user isolation.
- Client bridge: `app/rust/src/api/recovery.rs` → Dart
  `features/recovery/recovery_service.dart`.
- Verified end to end on-device: enroll → upload → new device → fetch → decrypt →
  restore → decrypt a live group message; wrong code rejected; the stored blob
  contains no plaintext state.
