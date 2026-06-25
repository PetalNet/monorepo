# PetalBoard

PetalBoard is a modern, mobile-friendly alternative to other platforms focused on coordinating events. Hosts can create an event in minutes, share a public link, and manage signups
without forcing guests to create accounts.

## Features

- 🎉 **Event creation** – Collect title, date, description, and location in one form.
- 🧺 **Slot management** – Add, edit, and remove required items while tracking remaining capacity.
- 🔐 **PIN-secured signups** – Guests reserve a slot with their name, optional email, and 4–6 digit
  PIN. The PIN is hashed using scrypt before storage.
- 🔁 **Guest self-service** – Guests can edit or cancel their signup later using the signup ID and PIN.
- 🧮 **Overbooking prevention** – Server-side validation ensures slots never exceed their quantity.
- 🖨️ **Manage dashboard** – Token-protected view for organizers to edit event details, slots, and
  remove signups.

## Tech stack

- [SvelteKit](https://kit.svelte.dev/) for routing, server actions, and templating
- [Prisma](https://www.prisma.io/) ORM with SQLite (swap for Postgres when deploying)
- TypeScript everywhere for type safety
- PNPM for dependency management

## Getting started

1. **Install dependencies**

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

## Deploy with Docker

To build and run PetalBoard in a production-style container you only need Docker and PowerShell. The
included `deploy.ps1` script clones the repository (if needed), builds the Docker image, and runs the
container on a rarely used port (`4173`). Persistent SQLite data is stored in a `data/` directory next
to the cloned repo so it survives restarts.

```powershell
git clone https://github.com/petalboard/petalboard.git
cd petalboard
./deploy.ps1
```

After the script finishes, visit <http://localhost:4173>. To stop and remove the container later, run:

```powershell
docker rm -f petalboard-app
```

You can change the published port by supplying `-Port <port>` to `deploy.ps1`.

## Project structure

```
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

- Signup PINs are hashed with scrypt using Node's `crypto` module and per-signup salts.
- All mutations validate input with [Zod](https://zod.dev/).
- Organizer dashboards are protected with unique manage tokens generated at event creation.

Enjoy planning your next event without the clutter! 🌸
