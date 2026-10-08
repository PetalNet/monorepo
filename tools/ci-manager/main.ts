import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Schema } from "effect";
import { Command } from "effect/cli";

import { evaluateGate } from "./gate.ts";
import { select } from "./select.ts";

const gate = Effect.gen(function* () {
	const json = yield* Config.String("NEEDS_JSON");
	const jobs = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(json);
	const conclusions = yield* evaluateGate(jobs);
	yield* Console.log(conclusions.join("\n"));
});

Command.make("ci-manager").pipe(
	Command.withDescription("Select CI work and enforce exact job conclusions."),
	Command.withSubcommands([
		Command.make("select", {}, () => select).pipe(
			Command.withDescription(
				"Plan affected PR/merge-group work, or the full suite on main/manual runs.",
			),
		),
		Command.make("gate", {}, () => gate).pipe(
			Command.withDescription(
				"Fail unless every job matches its selected success/skipped conclusion.",
			),
		),
	]),
	Command.run({ version: "1.0.0" }),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
