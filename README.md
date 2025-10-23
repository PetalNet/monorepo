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

## 🐳 Production Deployment

This app is production-ready with Docker and Cloudflare Tunnel support.

**→ See [QUICKSTART.md](./QUICKSTART.md) for fast deployment**

**→ See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed documentation**

**→ See [DOCKER-SETUP.md](./DOCKER-SETUP.md) for complete overview**

### Quick Deploy
```sh
# On your production server
./deploy.sh                      # Deploy with Docker
./setup-cloudflare-tunnel.sh     # Set up Cloudflare Tunnel
./backup.sh                      # Backup database
```

## 📚 Documentation

- **[QUICKSTART.md](./QUICKSTART.md)** - Fast production deployment guide
- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Comprehensive deployment docs
- **[DOCKER-SETUP.md](./DOCKER-SETUP.md)** - Docker setup overview
- **[TIMEZONE_GUIDE.md](./TIMEZONE_GUIDE.md)** - Timezone handling guide

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
- **Deployment**: Docker + Cloudflare Tunnel

## ✨ Features

- 📊 Real-time presentation management
- 🎯 Live audience voting
- 🔐 Secure authentication
- 🌐 Timezone-aware scheduling
- 📱 Responsive design
- 🚀 Production-ready Docker setup
- 🔒 Cloudflare Tunnel integration

## 📝 License

MIT
