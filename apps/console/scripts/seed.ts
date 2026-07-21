// console-api-seed — the deploy bootstrap. Runs the ordered migration then
// seeds the baseline grants, producer registrations, and tier rows. Idempotent; run once per
// deploy (and safe to re-run). Mint the first bearer tokens with console-api-mint-token after.

import { migrate } from "../src/lib/server/domain/db/migrate.ts";
import { openDb } from "../src/lib/server/domain/db/pool.ts";
import { seedBootstrap } from "../src/lib/server/domain/db/seed.ts";
import { loadEnv } from "../src/lib/server/domain/env.ts";

async function main(): Promise<void> {
	const db = openDb(loadEnv());
	try {
		await migrate(db.admin);
		await seedBootstrap(db.admin);
		process.stdout.write("console-api: migrate + seed complete\n");
	} finally {
		await db.close();
	}
}

await main();
