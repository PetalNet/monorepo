import { createEffectApi, operation, operationError } from "@petalnet/effect-api";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { PlatformError } from "effect/PlatformError";

import { Vault } from "./engine.ts";
import { CaptureFailed, SecretFound, TierUnreadable, WriteRejected } from "./errors.ts";
import { project, renderNote } from "./project.ts";
import {
	ClaimCard,
	PassageHit,
	logRecall,
	recallClaims,
	recallPassages,
	reindex,
	renderCard,
	renderPassage,
} from "./recall.ts";
import {
	Recheck,
	RememberInput,
	ResearchRunInput,
	captureSource,
	remember,
	researchCheck,
	researchRun,
} from "./research.ts";
import { Claim, Run, Source, Text, Tier } from "./schema.ts";

/**
 * Brings the read side (claim index, and the projection when configured) up to date. The write is
 * already saved, so a failure here is reported and swallowed: failing would invite a retry that
 * stores the write twice.
 */
export const refresh = Effect.gen(function* () {
	const vault = yield* Vault;

	yield* reindex;

	if (vault.projection !== undefined) {
		yield* project(vault.projection);
	}
}).pipe(
	Effect.catchCause((cause) =>
		Effect.logWarning("Saved, but the index or projection could not be refreshed", cause),
	),
);

const errors = {
	WriteRejected: operationError(WriteRejected, { status: 422, message: (error) => error.message }),
	SecretFound: operationError(SecretFound, { status: 422, message: (error) => error.message }),
	CaptureFailed: operationError(CaptureFailed, { status: 502, message: (error) => error.message }),
	TierUnreadable: operationError(TierUnreadable, { status: 500 }),
	PlatformError: operationError(PlatformError, { status: 500 }),
};

const tier = Schema.optionalKey(Tier);
const Retire = Schema.Struct({ id: Text, reason: Text });

const RecallInput = Schema.Struct({
	query: Text,
	k: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
	tiers: Schema.optionalKey(
		Schema.Array(Tier).annotate({ description: "Limit results to these tiers. Default: all." }),
	),
	passages: Schema.optionalKey(
		Schema.Boolean.annotate({
			description: "Also search passages of migrated documents and quoted sources.",
		}),
	),
});

const recall = Effect.fnUntraced(function* (input: typeof RecallInput.Type) {
	const options = { k: input.k ?? 8, ...(input.tiers === undefined ? {} : { tiers: input.tiers }) };
	const claims = yield* recallClaims(input.query, options);
	const passages = input.passages === true ? yield* recallPassages(input.query, options) : [];

	yield* logRecall(
		input.query,
		claims.map((card) => card.id),
	);

	return {
		claims,
		passages,
		text:
			[...claims.map(renderCard), ...passages.map(renderPassage)].join("\n") || "No claim matches.",
	};
});

/** The vault's agent surface. Every write refreshes the read side before it returns. */
export const operations = [
	operation({
		name: "recall",
		description:
			"Search the vault's claims. Each result is one claim with its topic and heading, its sources and how fresh they are. Cite claims by ID. Call this before researching or answering from memory.",
		input: RecallInput,
		output: Schema.Struct({
			claims: Schema.Array(ClaimCard),
			passages: Schema.Array(PassageHit),
			text: Schema.String,
		}),
		handler: recall,
		errors,
	}),
	operation({
		name: "remember",
		description:
			"Add a single claim to a topic. Give `source` (a vault source ID, URL, DOI or arXiv ID; unsaved references are captured first) or `direct` (who said or observed it, with the quote). A claim with neither is stored as a GUESS. To correct a claim, pass `replaces` with its ID; claims are never edited.",
		input: Schema.Struct({ ...RememberInput.fields, tier }),
		output: Claim,
		handler: ({ tier: chosen, ...input }) =>
			remember(chosen ?? "shared", input).pipe(Effect.tap(() => refresh)),
		errors,
	}),
	operation({
		name: "research_check",
		description:
			"First step of any research: returns matching claims and passages, plus `recheck`, the sources behind them that are stale, replaced or retracted. Fetch only what is missing, and look for something newer only for `recheck` sources.",
		input: Schema.Struct({ question: Text }),
		output: Schema.Struct({
			claims: Schema.Array(ClaimCard),
			passages: Schema.Array(PassageHit),
			recheck: Schema.Array(Recheck),
		}),
		handler: ({ question }) =>
			researchCheck(question).pipe(
				Effect.tap((check) =>
					logRecall(
						question,
						check.claims.map((card) => card.id),
					),
				),
			),
		errors,
	}),
	operation({
		name: "research_run",
		description:
			"Record a finished research run: topics, quoted passages, claims with verdicts and typed links, reused IDs and gaps. Every cited source must already be in the vault (use source_add). Returns the run and its run note, the root of the tree.",
		input: Schema.Struct({ ...ResearchRunInput.fields, tier }),
		output: Schema.Struct({ run: Run, note: Schema.String }),
		handler: ({ tier: chosen = "shared", ...input }) =>
			Effect.gen(function* () {
				const run = yield* researchRun(chosen, input);

				yield* refresh;

				return { run, note: yield* renderNote(`${chosen}/Runs/${run.id}.md`) };
			}),
		errors,
	}),
	operation({
		name: "source_add",
		description:
			"Save a URL, DOI or arXiv ID through vault-cite and add it to the vault. Already-saved sources are reused without a fetch. Fails when the capture fails; record that reference as a gap.",
		input: Schema.Struct({ ref: Text, tier }),
		output: Source,
		handler: ({ ref, tier: chosen }) =>
			captureSource(chosen ?? "shared", ref).pipe(Effect.tap(() => refresh)),
		errors,
	}),
	operation({
		name: "source_retire",
		description:
			"Mark a source replaced (give `replacedBy`) or retracted. Every claim that cites it is flagged stale; the flagged claim IDs are returned.",
		input: Schema.Struct({
			...Retire.fields,
			replacedBy: Schema.optionalKey(
				Text.annotate({ description: "The newer source. Omit to retract the source outright." }),
			),
		}),
		output: Schema.Struct({ flagged: Schema.Array(Schema.String) }),
		handler: ({ id, reason, replacedBy }) =>
			Effect.flatMap(Vault, (vault) =>
				vault.retireSource(
					id,
					replacedBy === undefined
						? { status: "retracted", reason }
						: { status: "replaced", replacedBy, reason },
				),
			).pipe(
				Effect.tap(() => refresh),
				Effect.map((flagged) => ({ flagged })),
			),
		errors,
	}),
	operation({
		name: "claim_retract",
		description: "Mark a claim retracted with a reason. The claim and its ID stay in the vault.",
		input: Retire,
		output: Claim,
		handler: ({ id, reason }) =>
			Effect.gen(function* () {
				const vault = yield* Vault;
				const home = (yield* vault.view).locate(id);

				if (home?.kind !== "claims") {
					return yield* new WriteRejected({ message: `${id} is not in the vault` });
				}

				const claim = yield* vault.transact(home.tier, `retract claim ${id}`, (tx) =>
					tx.retractClaim(id, reason),
				);

				yield* refresh;

				return claim;
			}),
		errors,
	}),
];

/** The operations over MCP (Streamable HTTP at `/mcp`), on whatever HTTP server hosts the layer. */
export const vaultApi = createEffectApi({
	title: "Vault",
	version: "0.0.0",
	basePath: "/api",
	operations: [],
	mcpOperations: operations,
});

/**
 * `vault serve` has no credentials: its boundary is the loopback port. A browser page can still
 * reach that port by DNS rebinding, and it always sends a Host the rebound name controls and, on a
 * cross-origin request, an Origin. So only a loopback Host is served and any Origin is refused.
 */
export const loopbackOnly = <E, R>(
	app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	E,
	R | HttpServerRequest.HttpServerRequest
> =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;

		return isLoopbackHost(request.headers["host"]) && request.headers["origin"] === undefined
			? yield* app
			: HttpServerResponse.text("forbidden", { status: 403 });
	});

const isLoopbackHost = (host: string | undefined): boolean =>
	host !== undefined && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
