import { Schema } from "effect";

const Enabled = Schema.Literals(["true", "false"]);
export const Selection = Schema.Struct({
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

export const Needs = Schema.Record(
	Schema.String,
	Schema.Struct({
		result: Schema.Literals(["success", "failure", "cancelled", "skipped"]),
		outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	}),
);

const selected = (enabled: typeof Enabled.Type) => (enabled === "true" ? "success" : "skipped");

export function expectedConclusions(selection: typeof Selection.Type) {
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
