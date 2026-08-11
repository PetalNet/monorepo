import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { importCollegeBreaks } from "../src/lib/server/college-breaks-import";
import * as schema from "../src/lib/server/db/schema";

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("import-college-breaks: DATABASE_URL is not set");
	process.exit(2);
}

const client = createClient({ url });
const db = drizzle(client, { schema });

try {
	const sourceRows = await importCollegeBreaks(db);
	console.log(`import-college-breaks: processed ${String(sourceRows)} source rows`);
} catch (error) {
	console.error("import-college-breaks:", error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	client.close();
}
