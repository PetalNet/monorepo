#!/usr/bin/env node
// oxlint-disable effecttsgo/unstable-api-usage -- Effect 4 exposes the CLI through unstable APIs.
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { HttpRouter } from "effect/http";

import { loopbackOnly, operations, refresh, vaultApi } from "./api.ts";
import { CollectSpec, collect } from "./collect.ts";
import { Vault } from "./engine.ts";
import { CaptureFailed, SecretFound, WriteRejected } from "./errors.ts";
import { ManifestEntry, migrate } from "./migrate.ts";
import { lint, project } from "./project.ts";
import { indexPath, reindex } from "./recall.ts";
import { Cite } from "./research.ts";
import { tiers } from "./schema.ts";

const print = (value: unknown) =>
	Console.log(typeof value === "string" ? value : JSON.stringify(value, null, 1));

/** Runs one agent operation exactly as MCP would: its input schema decodes what the flags gave. */
const call = Effect.fnUntraced(function* (
	name: (typeof operations)[number]["name"],
	input: object,
) {
	const found = operations.find((each) => each.name === name);

	if (found === undefined) {
		return yield* Effect.die(`No operation ${name}`);
	}

	return yield* found.handle(yield* Schema.decodeEffect(found.input)(input));
});

const optional = <A>(flag: Flag.Flag<A>) => Flag.optional(flag);
const some = <A>(key: string, value: Option.Option<A>) =>
	Option.match(value, { onNone: () => ({}), onSome: (found) => ({ [key]: found }) });

const words = Argument.String("text").pipe(Argument.variadic({ min: 1 }));
const tier = optional(Flag.Literals("tier", tiers));
const reason = Flag.String("reason");
const folder = Argument.String("dir").pipe(Argument.optional);
const tierArgument = Argument.Literals("tier", tiers);

const out = (dir: Option.Option<string>) =>
	Effect.map(Vault, (vault) =>
		Option.getOrElse(dir, () => vault.projection ?? path.join(vault.root, "obsidian")),
	);

const commands = [
	Command.make(
		"recall",
		{
			query: words,
			k: optional(Flag.Int("k")),
			passages: Flag.Boolean("passages").pipe(Flag.withDefault(false)),
			json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
		},
		({ query, k, passages, json }) =>
			call("recall", { query: query.join(" "), passages, ...some("k", k) }).pipe(
				Effect.flatMap((result) => print(json ? result : (result as { text: string }).text)),
			),
	).pipe(
		Command.withDescription("Claims matching the query, each with its sources and freshness."),
	),
	Command.make(
		"remember",
		{
			text: words,
			topic: Flag.String("topic"),
			heading: optional(Flag.String("heading")),
			tier,
			source: optional(Flag.String("source")),
			quote: optional(Flag.String("quote")),
			direct: optional(Flag.String("direct")),
			replaces: optional(Flag.String("replaces")),
		},
		(flags) =>
			call("remember", {
				text: flags.text.join(" "),
				topic: flags.topic,
				...some("heading", flags.heading),
				...some("tier", flags.tier),
				...some("source", flags.source),
				...some("replaces", flags.replaces),
				...Option.match(flags.direct, {
					onNone: () => some("quote", flags.quote),
					onSome: (title) => ({
						direct: { title, quote: Option.getOrElse(flags.quote, () => "") },
					}),
				}),
			}).pipe(Effect.flatMap(print)),
	).pipe(
		Command.withDescription("Store one sourced claim; an unsaved reference is captured first."),
	),
	Command.make("research-check", { question: words }, ({ question }) =>
		call("research_check", { question: question.join(" ") }).pipe(Effect.flatMap(print)),
	).pipe(
		Command.withDescription("What the vault holds on a question, and which sources to re-check."),
	),
	Command.make(
		"research-run",
		{ file: Argument.String("file").pipe(Argument.optional) },
		({ file }) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const text = yield* fs.readFileString(Option.getOrElse(file, () => "/dev/stdin"));
				const input = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text);
				const result = yield* call("research_run", input as object);

				yield* print((result as { note: string }).note);
			}),
	).pipe(
		Command.withDescription(
			"Write a research run tree from JSON (a file or stdin); prints the run note.",
		),
	),
	Command.make("source").pipe(
		Command.withDescription("Capture, replace or retract a source."),
		Command.withSubcommands([
			Command.make("add", { ref: Argument.String("ref"), tier }, ({ ref, tier: chosen }) =>
				call("source_add", { ref, ...some("tier", chosen) }).pipe(Effect.flatMap(print)),
			),
			Command.make(
				"replace",
				{ id: Argument.String("id"), replacedBy: Argument.String("new-id"), reason },
				(input) => call("source_retire", input).pipe(Effect.flatMap(print)),
			),
			Command.make("retract", { id: Argument.String("id"), reason }, (input) =>
				call("source_retire", input).pipe(Effect.flatMap(print)),
			),
		]),
	),
	Command.make("claim").pipe(
		Command.withDescription("Retract a claim."),
		Command.withSubcommands([
			Command.make("retract", { id: Argument.String("id"), reason }, (input) =>
				call("claim_retract", input).pipe(Effect.flatMap(print)),
			).pipe(Command.withDescription("Retract a claim. Its ID stays.")),
		]),
	),
	Command.make("project", { dir: folder }, ({ dir }) =>
		Effect.flatMap(out(dir), project).pipe(Effect.flatMap(print)),
	).pipe(
		Command.withDescription(
			"Regenerate the Obsidian vault (default: VAULT_PROJECTION or <root>/obsidian).",
		),
	),
	Command.make("lint", { dir: folder }, ({ dir }) =>
		Effect.gen(function* () {
			const result = yield* lint(yield* out(dir));

			yield* print(result);

			if (result.problems.length > 0) {
				process.exitCode = 1;
			}
		}),
	).pipe(
		Command.withDescription("Check claim IDs, passages and generated links in a projected vault."),
	),
	Command.make("reindex", {}, () => reindex.pipe(Effect.flatMap(print))).pipe(
		Command.withDescription("Rebuild the claim index."),
	),
	Command.make("reconcile", {}, () =>
		Effect.gen(function* () {
			const flagged = yield* (yield* Vault).reconcile("reconcile stale flags");

			yield* refresh;
			yield* print({ flagged });
		}),
	).pipe(
		Command.withDescription(
			"Flag claims whose sources were retired; finishes an interrupted retirement.",
		),
	),
	Command.make("history", { tier: tierArgument }, ({ tier: chosen }) =>
		Effect.flatMap(Vault, (vault) => vault.history(chosen)).pipe(Effect.flatMap(print)),
	).pipe(Command.withDescription("The op log: who wrote what, when.")),
	Command.make(
		"at",
		{ tier: tierArgument, time: Argument.Date("time") },
		({ tier: chosen, time }) =>
			Effect.flatMap(Vault, (vault) => vault.at(chosen, time)).pipe(Effect.flatMap(print)),
	).pipe(Command.withDescription("The tier as it stood at that time.")),
	Command.make("index", {}, () =>
		Effect.gen(function* () {
			const bytes = yield* (yield* FileSystem.FileSystem).readFile(indexPath((yield* Vault).root));

			process.stdout.write(bytes);
		}),
	).pipe(Command.withDescription("Write the claim index to stdout, for a read replica.")),
	Command.make("snapshot", { tier: tierArgument }, ({ tier: chosen }) =>
		Effect.gen(function* () {
			process.stdout.write(yield* (yield* Vault).snapshot(chosen));
		}),
	).pipe(Command.withDescription("Write the tier's Loro snapshot to stdout, as a backup.")),
	Command.make(
		"migrate",
		{
			manifest: Argument.String("manifest"),
			deny: optional(Flag.String("deny")),
			denyPassing: Flag.Int("deny-passing").pipe(Flag.withDefault(0)),
			report: optional(Flag.String("report")),
		},
		({ manifest, deny, denyPassing, report }) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const entries = yield* Schema.decodeEffect(
					Schema.Array(Schema.fromJsonString(ManifestEntry)),
				)((yield* fs.readFileString(manifest)).split("\n").filter(Boolean));
				const keywords = Option.isSome(deny)
					? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
							yield* fs.readFileString(deny.value),
						)
					: [];
				const result = yield* migrate(entries, keywords, denyPassing);

				if (Option.isSome(report)) {
					yield* fs.writeFileString(report.value, JSON.stringify(result, null, 1));
				}

				yield* refresh;

				yield* print({
					migrated: result.migrated.length,
					unchanged: result.unchanged.length,
					missing: result.missing.length,
					excluded: result.excluded.length,
					partial: result.partial.length,
					unsavedCitations: result.unsavedCitations.length,
				});
			}),
	).pipe(
		Command.withDescription(
			"Copy documents and vault-cite sources in; report exclusions and unsaved citations.",
		),
	),
	Command.make(
		"collect",
		{ spec: Argument.String("spec"), dir: Argument.String("out-dir") },
		({ spec, dir }) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const inputs = yield* Schema.decodeEffect(Schema.fromJsonString(CollectSpec))(
					yield* fs.readFileString(spec),
				);
				const result = yield* collect(inputs, dir);

				yield* print({
					entries: result.entries,
					cut: result.cut.length,
					titleOnly: result.titleOnly.length,
					withoutText: result.withoutText.length,
					skipped: result.skipped.length,
				});
			}),
	).pipe(
		Command.withDescription(
			"Build a migration manifest from a gallery database, note folders and a vault-cite index.",
		),
	),
	Command.make("status", {}, () =>
		Effect.gen(function* () {
			const vault = yield* Vault;
			const view = yield* vault.view;
			const counts = yield* Effect.forEach(
				tiers,
				(each) =>
					Effect.map(vault.history(each), (history) => {
						const state = view.tiers[each];

						return [
							each,
							{
								claims: Object.keys(state.claims).length,
								sources: Object.keys(state.sources).length,
								topics: Object.keys(state.topics).length,
								runs: Object.keys(state.runs).length,
								changes: history.length,
							},
						] as const;
					}),
				{ concurrency: 1 },
			);

			yield* print(Object.fromEntries(counts));
		}),
	).pipe(Command.withDescription("Claims, sources, topics, runs and changes per tier.")),
	Command.make(
		"serve",
		{
			host: Flag.String("host").pipe(Flag.withDefault("127.0.0.1")),
			port: Flag.Int("port").pipe(Flag.withDefault(7411)),
		},
		({ host, port }) =>
			Effect.gen(function* () {
				const services = yield* Effect.context<Vault | Cite>();

				yield* Console.error(`vault: MCP at http://${host}:${String(port)}/mcp`);

				return yield* Layer.launch(
					HttpRouter.serve(Layer.merge(vaultApi, Layer.succeedContext(services)), {
						middleware: loopbackOnly,
					}).pipe(Layer.provide(NodeHttpServer.layer(createServer, { host, port }))),
				);
			}),
	).pipe(Command.withDescription("Serve the agent operations over MCP (Streamable HTTP at /mcp).")),
];

/**
 * `VAULT_ROOT` is this host's vault, `VAULT_AGENT` names the writer, `VAULT_CITE` is the vault-cite
 * command (split on spaces) and `VAULT_PROJECTION` an Obsidian folder to keep current.
 */
const VaultLive = Layer.unwrap(
	Effect.gen(function* () {
		const root = yield* Config.String("VAULT_ROOT").pipe(
			Config.withDefault(path.join(os.homedir(), ".local", "share", "vault")),
		);
		const agent = yield* Config.String("VAULT_AGENT").pipe(
			Config.withDefault(os.userInfo().username),
		);
		const cite = yield* Config.String("VAULT_CITE").pipe(Config.withDefault(""));
		const projection = yield* Config.option(Config.String("VAULT_PROJECTION"));

		return Layer.mergeAll(
			Vault.layer({ root, agent, ...some("projection", projection) }),
			Cite.layer(cite.split(" ").filter(Boolean)),
		);
	}),
);

const vault = Command.make("vault").pipe(
	Command.withDescription("The lab's knowledge vault: sourced claims, recall and research runs."),
	Command.withSubcommands(commands),
);

NodeRuntime.runMain(
	Command.run(vault, { version: "0.0.0" }).pipe(
		// A refused write is an answer, not a crash: print what was refused and exit 1.
		Effect.catchIf(Schema.is(Schema.Union([WriteRejected, SecretFound, CaptureFailed])), (error) =>
			Console.error(error.message).pipe(
				Effect.andThen(
					Effect.sync(() => {
						process.exitCode = 1;
					}),
				),
			),
		),
		Effect.provide(VaultLive.pipe(Layer.provideMerge(NodeServices.layer))),
	),
);
