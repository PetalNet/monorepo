import { defineConfig } from "effect-db";

export default defineConfig({
	dialect: "postgres",
	db: { urlEnv: "DATABASE_URL" },
	source: { include: ["src/lib/server/db/tables.ts"] },
	filter: { schemas: ["public"] },
	migrations: { dir: "migrations", table: "effect_qb_migrations" },
	safety: { nonDestructiveDefault: true },
});
