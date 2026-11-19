import { DATABASE_URL } from "$app/env/private";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "./generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
	globalForPrisma.prisma ??
	new PrismaClient({
		// The generated client does not read .env; SvelteKit's env does, in dev and production.
		adapter: new PrismaBetterSqlite3(
			{ url: DATABASE_URL ?? "" },
			{ timestampFormat: "unixepoch-ms" },
		),
		log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
	});

if (process.env.NODE_ENV !== "production") {
	globalForPrisma.prisma = prisma;
}
