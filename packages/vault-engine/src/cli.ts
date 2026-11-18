#!/usr/bin/env node
// oxlint-disable effecttsgo/unstable-api-usage -- Effect 4 exposes the CLI through unstable APIs.
import os from "node:os";
import path from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Layer, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { operations, refresh } from "./api.ts";
import { Vault } from "./engine.ts";
import { SecretFound, WriteRejected } from "./errors.ts";
import { reindex } from "./recall.ts";
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

const commands = [
	Command.make(
		"recall",
		{
			query: words,
			k: optional(Flag.Int("k")),
			json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
		},
		({ query, k, json }) =>
			call("recall", { query: query.join(" "), ...some("k", k) }).pipe(
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
	).pipe(Command.withDescription("Store one sourced claim.")),
	Command.make("source").pipe(
		Command.withDescription("Replace or retract a source."),
		Command.withSubcommands([
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
];

/** `VAULT_ROOT` is this host's vault and `VAULT_AGENT` names the writer. */
const VaultLive = Layer.unwrap(
	Effect.gen(function* () {
		const root = yield* Config.String("VAULT_ROOT").pipe(
			Config.withDefault(path.join(os.homedir(), ".local", "share", "vault")),
		);
		const agent = yield* Config.String("VAULT_AGENT").pipe(
			Config.withDefault(os.userInfo().username),
		);

		return Vault.layer({ root, agent });
	}),
);

const vault = Command.make("vault").pipe(
	Command.withDescription("The lab's knowledge vault: sourced claims and recall."),
	Command.withSubcommands(commands),
);

NodeRuntime.runMain(
	Command.run(vault, { version: "0.0.0" }).pipe(
		// A refused write is an answer, not a crash: print what was refused and exit 1.
		Effect.catchIf(Schema.is(Schema.Union([WriteRejected, SecretFound])), (error) =>
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
