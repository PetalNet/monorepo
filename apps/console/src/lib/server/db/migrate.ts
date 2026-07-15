import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required");

const migration = await readFile(
	fileURLToPath(new URL("../../../../migrations/001-foundation.sql", import.meta.url)),
	"utf8",
);
const client = new Client({ connectionString: databaseUrl });
await client.connect();
await client.query(migration);
await client.end();
