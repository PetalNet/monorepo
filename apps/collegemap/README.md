# Map

## Deploy

Requires Docker and Docker Compose.

```sh
docker compose up --build -d
```

The app will be available at `http://localhost:4718`.

Data is persisted in a Docker volume (`map-data`). It survives container restarts and rebuilds.

## Stop

```sh
docker compose down
```

## Development

```sh
pnpm install
cp .env.example .env
pnpm db:push
pnpm dev
```
