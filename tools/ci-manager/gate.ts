import { Config, Console, Effect, Schema } from "effect";

const Enabled = Schema.Literals(["true", "false"]);
const Selection = Schema.Struct({
	"manager-rust": Enabled,
	"courier-rust": Enabled,
	"dispatcher-rust": Enabled,
	"control-plane-rust": Enabled,
	"box-agent-rust": Enabled,
	point: Enabled,
	rust: Enabled,
	js: Enabled,
	actions: Enabled,
	"codeql-js": Enabled,
	"codeql-python": Enabled,
});

const Needs = Schema.Record(
	Schema.String,
	Schema.Struct({
		result: Schema.Literals(["success", "failure", "cancelled", "skipped"]),
		outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	}),
);

class GateFailed extends Schema.TaggedError<GateFailed>()("GateFailed", {
	message: Schema.String,
}) {}

const selected = (enabled: typeof Enabled.Type) => (enabled === "true" ? "success" : "skipped");

function expectedConclusions(selection: typeof Selection.Type) {
	return {
		select: "success",
		check: "success",
		typos: "success",
		"link-check": "success",
		zizmor: "success",
		build: selected(selection.js),
		test: selected(selection.js),
		"manager-rust": selected(selection["manager-rust"]),
		"courier-rust": selected(selection["courier-rust"]),
		"dispatcher-rust": selected(selection["dispatcher-rust"]),
		"control-plane-rust": selected(selection["control-plane-rust"]),
		"box-agent-rust": selected(selection["box-agent-rust"]),
		point: selected(selection.point),
		"codeql-js": selected(selection["codeql-js"]),
		"codeql-python": selected(selection["codeql-python"]),
		"codeql-actions": selected(selection.actions),
		"codeql-rust": selected(selection.rust),
	};
}

export const evaluateGate = Effect.fn("evaluateGate")(function* (json: string) {
	const jobs = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Needs))(json);
	const selection = yield* Schema.decodeUnknownEffect(Selection)(jobs["select"]?.outputs);
	const expected = expectedConclusions(selection);
	const errors: string[] = [];
	const conclusions: string[] = [];
	for (const [job, conclusion] of Object.entries(expected)) {
		const actual = jobs[job]?.result;
		conclusions.push(`${job}: ${actual ?? "missing"} (expected ${conclusion})`);
		if (actual !== conclusion)
			errors.push(`${job}: expected ${conclusion}, got ${actual ?? "missing"}`);
	}
	for (const job of Object.keys(jobs)) {
		if (!Object.hasOwn(expected, job)) errors.push(`Unclassified job: ${job}`);
	}
	if (errors.length > 0) return yield* new GateFailed({ message: errors.join("\n") });
	return conclusions;
});

export const gate = Effect.gen(function* () {
	const conclusions = yield* evaluateGate(yield* Config.String("NEEDS_JSON"));
	yield* Console.log(conclusions.join("\n"));
});
