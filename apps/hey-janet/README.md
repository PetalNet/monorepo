# Hey Janet

A recording booth for Parker's wake-word training set. Participants give a first name and consent, then record 25 wake phrases and 15 near misses. An optional voice profile adds ten sentences and two 20–30 second answers, either on its own or after the wake-word set. PetalNet sign-in is optional. Accepted takes survive reloads in IndexedDB and retry failed uploads. Parker can review clips at `/admin` and export kept recordings as `positives/` and `negatives/`.

## Run

From the monorepo root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @petalnet/hey-janet dev --host 127.0.0.1 --port 18806
```

Use HTTPS outside localhost. Local recordings go into `apps/hey-janet/.cache/recordings`. Each participant has a stable ID/name folder containing 16 kHz mono 16-bit WAVs, clip metadata and `clips.jsonl`. Wake-word clips keep their `pos_`/`neg_` names. Voice profiles use `enroll_NN_*.wav` and `free_NN.wav`; free-speech numbers increase across sets to avoid overwriting takes. Keep/drop changes metadata, never audio. Speaker-ID export contains kept enrollment and free-speech clips in per-participant folders, each with `clips.jsonl`. Run one server process.

```sh
pnpm --filter @petalnet/hey-janet check
pnpm --filter @petalnet/hey-janet test
pnpm --filter @petalnet/hey-janet build
pnpm --filter @petalnet/hey-janet exec playwright install chromium webkit firefox
pnpm --filter @petalnet/hey-janet test:e2e
```

Browser tests use fake microphones, port 18806 and isolated storage. Headless Firefox needs PulseAudio, which CI starts.

## Deploy

Janet applies from reviewed main. Do not build images on .14.

1. On another machine, build from the monorepo root with `docker build -f apps/hey-janet/Dockerfile -t hey-janet .`. Transfer the image with `docker save` and `docker load` to .14.
2. Verify `findmnt -M /services` shows `10.10.10.12:/mnt/JeremyBearimy/Backups/Services`. Create `/services/hey-janet/recordings`, writable by uid 1000.
3. Copy `deploy/.env.example` to `deploy/.env`. Set a stable random `BOOTH_SECRET` of at least 32 characters. For optional sign-in, create a confidential Authentik OIDC provider with `openid profile`, the issuer shown in the example, and strict redirect `https://heyjanet.petalcat.dev/auth/callback`. Set its client credentials and Parker's exact `BOOTH_ADMIN_SUB`, or a Parker-only `BOOTH_ADMIN_GROUP` included in the signed ID token.
4. Verify port 8806 is free. Run `docker compose -f apps/hey-janet/deploy/compose.yml config --quiet`, then `docker compose -f apps/hey-janet/deploy/compose.yml up -d --no-build`. Check `curl --fail http://127.0.0.1:8806/health`.
5. Copy `deploy/traefik.yml` to `/home/docker/traefik/dynamic/hey-janet.yml`. Verify DNS and HTTPS for `heyjanet.petalcat.dev`, guest recording on physical iPhone Safari, upload recovery, Parker's review/export access, and denial for other accounts before sharing the link.
