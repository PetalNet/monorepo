import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import * as PgClient from "@effect/sql-pg/PgClient";
import { Data, Effect, Redacted } from "effect";

class MigrationError extends Data.TaggedError("MigrationError")<{ readonly message: string }> {}

export interface MigrationFile {
	readonly name: string;
	readonly checksum: string;
	readonly sql: string;
	readonly downSql?: string;
}

export const readMigrationFilesEffect = (directory: string) =>
	Effect.tryPromise(async () => {
		const names = (await readdir(directory))
			.filter((name) => /^\d+_.+\.sql$/.test(name))
			.toSorted();

		return Promise.all(
			names.map(async (name): Promise<MigrationFile> => {
				const contents = (await readFile(`${directory}/${name}`, "utf8")).replaceAll("\r\n", "\n");
				const sections = contents
					.replace(/^-- effect-db:up\s*\n/, "")
					.split(/^-- effect-db:down\s*$/m);
				const down = sections.at(1)?.trim();

				return {
					name,
					sql: sections[0].trim(),
					...(down ? { downSql: down } : {}),
					checksum: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
				};
			}),
		);
	});

// Split only at top-level semicolons: reviewed SQL contains DO/functions, quoted
// identifiers, strings, and comments. Never split procedural bodies on ';'.
const statements = (source: string) => {
	const result: string[] = [];
	let start = 0;
	let quote = "";
	let escapedString = false;
	let blockDepth = 0;
	let lineComment = false;

	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		const next = source[i + 1];

		if (lineComment) {
			if (c === "\n") {
				lineComment = false;
			}

			continue;
		}

		if (blockDepth) {
			if (c === "/" && next === "*") {
				blockDepth++;
				i++;
			} else if (c === "*" && next === "/") {
				blockDepth--;
				i++;
			}

			continue;
		}

		if (quote) {
			if (quote === "'" && escapedString && c === "\\") {
				i++;

				continue;
			}

			if (source.startsWith(quote, i)) {
				if (quote.length === 1 && next === quote) {
					i++;

					continue;
				}

				i += quote.length - 1;
				quote = "";
			}

			continue;
		}

		if (c === "-" && next === "-") {
			lineComment = true;
			i++;
		} else if (c === "/" && next === "*") {
			blockDepth = 1;
			i++;
		} else if (c === "'" || c === '"') {
			quote = c;

			escapedString =
				c === "'" && /[eE]/.test(source[i - 1] ?? "") && !/[\w$]/.test(source[i - 2] ?? "");
		} else if (c === "$") {
			const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i))?.[0];

			if (tag) {
				quote = tag;
				i += tag.length - 1;
			}
		} else if (c === ";") {
			result.push(source.slice(start, i + 1));
			start = i + 1;
		}
	}

	if (quote || blockDepth || source.includes("\0")) {
		throw new Error("Invalid migration SQL");
	}

	if (source.slice(start).trim()) {
		result.push(source.slice(start));
	}

	return result;
};

const executeScript = (source: string) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const parts = yield* Effect.try(() => statements(source));

		for (const part of parts) {
			yield* sql.unsafe(part);
		}
	});

const ensureMigrationTable = () =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;

		yield* sql`create table if not exists effect_qb_migrations (
		id bigint generated always as identity primary key, name text not null unique,
		checksum text, applied_at timestamptz not null default now())`;

		yield* sql`alter table effect_qb_migrations add column if not exists checksum text`;
		yield* sql`alter table effect_qb_migrations alter column checksum drop not null`;
	});

export const applyMigrationFiles = (files: readonly MigrationFile[]) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;

		for (const file of files) {
			yield* executeScript(file.sql);
			yield* sql`insert into effect_qb_migrations (name, checksum) values (${file.name}, ${file.checksum})`;
		}
	});

export const migrate = (direction: "up" | "down" = "up", steps = 1) =>
	Effect.gen(function* () {
		const files = yield* readMigrationFilesEffect(import.meta.dirname);
		const sql = yield* PgClient.PgClient;

		yield* sql.withTransaction(
			Effect.gen(function* () {
				// Serialize boot-time migrations, including creation/adoption of the ledger.
				yield* sql`select pg_advisory_xact_lock(1735551078)`;
				yield* ensureMigrationTable();

				const applied = yield* sql<{
					name: string;
					checksum: string | null;
				}>`select name, checksum from effect_qb_migrations order by id`;

				for (const row of applied) {
					const file = files.find((candidate) => candidate.name === row.name);

					if (!file) {
						return yield* new MigrationError({ message: `Missing applied migration: ${row.name}` });
					}

					if (row.checksum !== null && row.checksum !== file.checksum) {
						return yield* new MigrationError({
							message: `Migration checksum mismatch: ${row.name}`,
						});
					}

					if (row.checksum === null) {
						yield* sql`update effect_qb_migrations set checksum=${file.checksum} where name=${row.name}`;
					}
				}

				if (direction === "up") {
					yield* applyMigrationFiles(
						files.filter((file) => !applied.some((row) => row.name === file.name)),
					);
				} else {
					for (const row of applied.toReversed().slice(0, steps)) {
						const file = files.find((candidate) => candidate.name === row.name);

						if (!file?.downSql) {
							return yield* new MigrationError({ message: `No reviewed rollback: ${row.name}` });
						}

						yield* executeScript(file.downSql);
						yield* sql`delete from effect_qb_migrations where name=${file.name}`;
					}
				}
			}),
		);
	});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const direction = process.argv[2] ?? "up";
	const steps = Number(process.argv[3] ?? 1);

	if ((direction !== "up" && direction !== "down") || !Number.isSafeInteger(steps) || steps < 1) {
		throw new Error("Usage: node migrations/runner.ts [up|down] [positive steps]");
	}

	if (!process.env.DATABASE_URL) {
		throw new Error("DATABASE_URL is required");
	}

	await Effect.runPromise(
		migrate(direction, steps).pipe(
			Effect.provide(PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL) })),
		),
	);
}
