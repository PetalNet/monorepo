import { defineConfig } from "effect-db";

export default defineConfig({
	dialect: "postgres",
	db: { url: process.env.DATABASE_URL },
	source: { include: ["src/lib/server/db/tables.ts"] },
	migrations: { dir: "migrations", table: "effect_qb_migrations" },
	safety: { nonDestructiveDefault: true },
});
