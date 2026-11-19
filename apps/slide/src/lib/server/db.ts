import { DATABASE_URL } from "$app/env/private";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "./generated/prisma/client";

declare global {
	var prisma: PrismaClient | undefined;
}

const prisma =
	global.prisma ||
	new PrismaClient({
		adapter: new PrismaBetterSqlite3(
			{ url: DATABASE_URL ?? "" },
			{ timestampFormat: "unixepoch-ms" },
		),
	});

if (process.env.NODE_ENV !== "production") {
	global.prisma = prisma;
}

export { prisma };
