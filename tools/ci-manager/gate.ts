import { Config, Console, Effect, Schema } from "effect";

import { expectedConclusions, Needs, Selection } from "./workflow.ts";

// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a class factory, not a constructor.
class GateFailed extends Schema.TaggedError<GateFailed>()("GateFailed", {
	message: Schema.String,
}) {}

export const evaluateGate = Effect.fn("evaluateGate")(function* (json: string) {
	const jobs = yield* Schema.decodeEffect(Schema.fromJsonString(Needs))(json);
	const selection = yield* Schema.decodeUnknownEffect(Selection)(jobs["select"]?.outputs);
	const expected = expectedConclusions(selection);
	const errors: string[] = [];
	const conclusions: string[] = [];
	for (const [job, conclusion] of Object.entries(expected)) {
		const actual = jobs[job]?.result;
		conclusions.push(`${job}: ${actual ?? "missing"} (expected ${conclusion})`);
		if (actual !== conclusion) {
			errors.push(`${job}: expected ${conclusion}, got ${actual ?? "missing"}`);
		}
	}
	for (const job of Object.keys(jobs)) {
		if (!Object.hasOwn(expected, job)) {
			errors.push(`Unclassified job: ${job}`);
		}
	}
	if (errors.length > 0) {
		return yield* new GateFailed({ message: errors.join("\n") });
	}
	return conclusions;
});

export const gate = Effect.gen(function* () {
	const conclusions = yield* evaluateGate(yield* Config.String("NEEDS_JSON"));
	yield* Console.log(conclusions.join("\n"));
});
