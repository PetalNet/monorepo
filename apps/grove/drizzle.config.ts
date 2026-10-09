import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/lib/server/db/tables.ts",
	out: "./migrations/generated",
	dbCredentials: { url: process.env.DATABASE_URL ?? "" },
	tablesFilter: ["grove_*", "user", "account", "session", "verification"],
	introspect: { casing: "preserve" },
});
