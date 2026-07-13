import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";
import { embedText, vectorLiteral } from "./embedding.ts";

export interface SemanticSearchResult {
	kind: "statistic" | "query" | "view";
	source_ref: string;
	content: string;
	score: number;
}

/** Scope-filtered hybrid pgvector + full-text retrieval used directly by the L3 compiler. */
export async function searchSemanticCorpus(
	app: Sql,
	scopes: readonly string[],
	query: string,
	limit = 8,
): Promise<SemanticSearchResult[]> {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const boundedLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 32) : 8;
	const embedding = vectorLiteral(embedText(trimmed));
	return withScopes(app, scopes, async (tx) => {
		await tx`select set_config('hnsw.iterative_scan', 'strict_order', true)`;
		const rows = await tx<
			{
				kind: SemanticSearchResult["kind"];
				source_ref: string;
				content: string;
				score: number;
			}[]
		>`
			select kind, source_ref, content,
				(0.75 * greatest(0, least(1, (2 - distance) / 2)) +
				 0.25 * (text_rank / (text_rank + 1)))::float8 as score
			from (
				select *, embedding <=> ${embedding}::vector as distance,
					ts_rank_cd(to_tsvector('simple', content), plainto_tsquery('simple', ${trimmed})) as text_rank
				from semantic_documents
			) ranked
			order by score desc, source_ref asc
			limit ${boundedLimit}`;
		return rows.map((row) => ({ ...row, score: Number(row.score) }));
	});
}
