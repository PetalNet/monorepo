# Build stage
FROM node:20-alpine AS builder

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Generate Prisma Client
RUN pnpm prisma generate

# Build the application
RUN pnpm build

# Production stage
FROM node:20-alpine AS runner

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Copy prisma schema before installing dependencies
COPY prisma ./prisma

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Generate Prisma Client in production
RUN pnpm prisma generate

# Copy built application from builder
COPY --from=builder /app/build ./build

# Create directory for SQLite database
RUN mkdir -p /app/data

# Set environment variables
ENV NODE_ENV=production
ENV DATABASE_URL="file:/app/data/prod.db"
ENV ORIGIN=http://localhost:3420
ENV PORT=3420
ENV ADMIN_EMAIL=""

# Expose port
EXPOSE 3420

# Start the application
CMD ["node", "build"]
