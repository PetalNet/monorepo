import { Effect } from "effect";

import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";
import type { QueryRequest } from "./structured.ts";

export interface QueryRecord {
	query_ref: string;
	request: QueryRequest;
	sql_text: string;
	columns: { name: string; type: string }[];
	row_count: number;
	execution_ms: number | null;
	created_at: string;
}

export function readQueryRecord(
	app: Sql,
	scopes: readonly string[],
	queryRef: string,
): Effect.Effect<QueryRecord | null> {
	return Effect.promise(() =>
		withScopes(app, scopes, async (tx) => {
			const rows = await tx<QueryRecord[]>`
			select query_ref, request, sql_text, columns, row_count, execution_ms, created_at
			from query_history where query_ref = ${queryRef}`;
			return rows.at(0) ?? null;
		}),
	);
}
