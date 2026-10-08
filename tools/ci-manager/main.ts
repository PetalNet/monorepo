import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";

import { gate } from "./gate.ts";
import { runJS } from "./run.ts";
import { select } from "./select.ts";

const program = Command.make("ci-manager").pipe(
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
		Command.make("build", {}, () => runJS("build")).pipe(
			Command.withDescription("Build exactly the selected JS packages."),
		),
		Command.make("test", {}, () => runJS("test")).pipe(
			Command.withDescription("Test exactly the selected JS packages."),
		),
	]),
);

NodeRuntime.runMain(
	program.pipe(Command.run({ version: "1.0.0" }), Effect.provide(NodeServices.layer)),
);
