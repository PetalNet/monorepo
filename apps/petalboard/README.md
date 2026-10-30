# PetalBoard

PetalBoard is a modern, mobile-friendly alternative to other platforms focused on coordinating events. Hosts can create an event in minutes, share a public link, and manage signups
without forcing guests to create accounts.

## Features

- 🎉 **Event creation** – Collect title, date, description, and location in one form.
- 🧺 **Slot management** – Add, edit, and remove required items while tracking remaining capacity.
- ✉️ **Passwordless signups** – Guests RSVP with their name and email. No password or PIN.
- 🔁 **Guest self-service** – The browser that RSVPs can edit or cancel any time; any other browser
  gets a single-use, one-hour edit link by email (see `EMAIL_SETUP.md`).
- 🧮 **Overbooking prevention** – Server-side validation ensures slots never exceed their quantity.
- 🖨️ **Manage dashboard** – Token-protected view for organizers to edit event details, slots, and
  remove signups.

## Tech stack

- [SvelteKit](https://kit.svelte.dev/) for routing, server actions, and templating
- [Prisma](https://www.prisma.io/) ORM with SQLite (swap for Postgres when deploying)
- TypeScript everywhere for type safety
- PNPM for dependency management

## Getting started

1. **Install dependencies** from the repository root

   ```bash
   pnpm install
   ```

2. **Configure the database**
   Copy the environment example and adjust if necessary.

   ```bash
   cp .env.example .env
   ```

   By default the project stores data in `prisma/dev.db` (ignored by git).

3. **Generate the Prisma client and run migrations**

   ```bash
   pnpm exec prisma migrate dev
   ```

4. **Start the dev server**
   ```bash
   pnpm run dev
   ```
   Open the logged URL (usually `http://localhost:5173`).

## Useful commands

```bash
pnpm run dev          # Start SvelteKit in dev mode
pnpm run build        # Build the production bundle
pnpm run preview      # Preview the production build
pnpm exec prisma studio  # Inspect the database UI
```

## Docker image

Build the image from the repository root, since it installs from the workspace lockfile:

```sh
docker build -f apps/petalboard/Dockerfile --build-arg MONOREPO_SHA="$(git rev-parse HEAD)" -t petalboard .
```

The container listens on port 4173, applies pending Prisma migrations on start, and keeps its
SQLite database at `/app/data/dev.db`. Mount a volume at `/app/data`. Set `ORIGIN` to the public
URL so form actions pass SvelteKit's CSRF check, and `APP_URL` to the same URL for email links.
Resend, Google Maps, and Spotify settings are listed in `.env.example`.

## Project structure

```text
src/
  lib/
    server/    # Prisma client and validation helpers
    utils/     # Formatting helpers
  routes/
    +page.svelte                # Landing page
    create/                     # Event creation flow
    event/[code]/               # Public event view and signup action
    event/manage/[token]/       # Organizer dashboard
    manage-signup/              # Guest lookup/edit page
    api/signups/{lookup,update,cancel}  # JSON endpoints for guest actions
prisma/
  schema.prisma                 # Database schema
```

## Security notes

- Guest edit cookies and emailed links are random 32-byte tokens; only their SHA-256 hashes are
  stored. Links work once, for 1 hour, and opening one never consumes it until the guest presses
  Continue.
- All mutations validate input with [Zod](https://zod.dev/).
- Organizer dashboards are protected with unique manage tokens generated at event creation.

Enjoy planning your next event without the clutter! 🌸
