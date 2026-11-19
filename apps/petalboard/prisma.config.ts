import { existsSync } from "node:fs";

import { defineConfig } from "prisma/config";

// Prisma 7 no longer loads .env on its own.
if (existsSync(".env")) {
	process.loadEnvFile(".env");
}

export default defineConfig({
	datasource: { url: process.env.DATABASE_URL ?? "" },
});
