// Apply pending Drizzle migrations, then exit. Run by docker-entrypoint.sh before the server starts.
//
// Replaces `npx drizzle-kit push --force`, which ran on EVERY container boot and diffed the live
// schema against the code with no review step and no confirmation. This applies reviewed, committed
// SQL files and records what it applied, so a boot can no longer invent a schema change.
//
// drizzle-orm is already a runtime dependency; drizzle-kit is not needed in the image at all.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

const url = process.env.DATABASE_URL;
if (url === undefined || url === "") {
	console.error("migrate: DATABASE_URL is not set");
	process.exit(2);
}

const migrationsFolder = process.env.MIGRATIONS_DIR ?? "./drizzle";

const client = createClient({ url });
const db = drizzle(client);

try {
	await migrate(db, { migrationsFolder });
	console.log(`migrate: up to date (${migrationsFolder})`);
} catch (error) {
	// Fail the boot loudly. A container that starts with an unmigrated database is worse than one
	// that refuses to start: it serves wrong or missing data and looks healthy while doing it.
	console.error("migrate: FAILED —", error instanceof Error ? error.message : String(error));
	process.exit(1);
} finally {
	client.close();
}
