# Slide - Interactive Presentation Platform

A real-time presentation and voting platform built with SvelteKit, featuring live updates, audience participation, and seamless event management.

## 🚀 Quick Start - Development

```sh
# Install dependencies
pnpm install

# Set up database
pnpm prisma migrate dev

# Start development server
pnpm dev
```

## 📚 Documentation

- **[ADMIN.md](./ADMIN.md)** - admin access setup
- **[TIMEZONE_GUIDE.md](./TIMEZONE_GUIDE.md)** - timezone handling guide

## 🔧 Development

```sh
# Start dev server
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview

# Type checking
pnpm check
```

## 🗄️ Database

Using SQLite with Prisma ORM:

```sh
# Create migration
pnpm prisma migrate dev

# View database
pnpm prisma studio

# Reset database
pnpm prisma migrate reset
```

## 🏗️ Tech Stack

- **Framework**: SvelteKit 5
- **Database**: SQLite + Prisma
- **Styling**: TailwindCSS
- **Real-time**: Server-Sent Events (SSE)
- **Auth**: Custom session-based auth with bcrypt

## ✨ Features

- 📊 Real-time presentation management
- 🎯 Live audience voting
- 🔐 Secure authentication
- 🌐 Timezone-aware scheduling
- 📱 Responsive design

## 📝 License

MIT
