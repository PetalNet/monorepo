import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const consoleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractDir = path.join(consoleDir, "docs/contracts");
const outDir = path.join(consoleDir, "src/lib/api");
const check = process.argv.includes("--check");

const readJson = async (relative) =>
	JSON.parse(await readFile(path.join(contractDir, relative), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

const catalog = await readJson("ops.json");

const typeSpecs = [
	["Principal", "schemas/principal.schema.json"],
	["Me", "schemas/entities/me.schema.json"],
	["AvailabilitySnapshot", "schemas/availability.schema.json"],
	["FleetItem", "schemas/entities/fleet.schema.json"],
	["RegistryItem", "schemas/entities/registry.schema.json"],
	["WorkerItem", "schemas/entities/worker.schema.json"],
	["BoxUpdateItem", "schemas/entities/box-update.schema.json"],
	["BoxUpdateRaw", "schemas/entities/box-update-raw.schema.json"],
	["UpdateApproval", "schemas/entities/update-approval.schema.json"],
	["ExecutorItem", "schemas/entities/executor.schema.json"],
	["HeartbeatItem", "schemas/entities/heartbeat.schema.json"],
	["TaskItem", "schemas/entities/task.schema.json"],
	["WorkSettlementSnapshot", "schemas/work-settlement.schema.json"],
	["LeaseItem", "schemas/entities/lease.schema.json"],
	["QueryResult", "schemas/query-result.schema.json"],
	["CatalogEntry", "schemas/entities/catalog-entry.schema.json"],
	["DashboardItem", "schemas/entities/dashboard-item.schema.json"],
	["EdgeRegistryItem", "schemas/entities/edge-registry.schema.json"],
	["EdgeSessionItem", "schemas/entities/edge-session.schema.json"],
	["SignalEmission", "schemas/emission.schema.json"],
	["SubscriptionItem", "schemas/subscription.schema.json"],
	["DeliveryItem", "schemas/entities/delivery.schema.json"],
	["SignalSourceModeItem", "schemas/entities/signal-source-mode.schema.json"],
	["ConsoleHealth", "schemas/health.schema.json"],
	["CardItem", "schemas/entities/card.schema.json"],
	["AttentionItem", "schemas/attention-item.schema.json"],
	["OpResult", "schemas/op-result.schema.json"],
	["GovernanceItem", "schemas/entities/governance.schema.json"],
	["RosterItem", "schemas/entities/roster.schema.json"],
	["CommsEvent", "schemas/entities/comms-event.schema.json"],
];

const schemas = Object.fromEntries(
	await Promise.all(typeSpecs.map(async ([name, file]) => [name, await readJson(file)])),
);

async function dereference(schema, fromFile, seen = new Set()) {
	if (Array.isArray(schema)) {
		return Promise.all(schema.map((item) => dereference(item, fromFile, seen)));
	}
	if (!schema || typeof schema !== "object") return schema;
	if (typeof schema.$ref === "string") {
		const [filePart, fragment = ""] = schema.$ref.split("#");
		const targetFile = filePart
			? path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), filePart))
			: fromFile;
		const key = `${targetFile}#${fragment}`;
		if (seen.has(key)) return {};
		let target = await readJson(targetFile);
		for (const token of fragment.replace(/^\//, "").split("/").filter(Boolean)) {
			target = target[token.replaceAll("~1", "/").replaceAll("~0", "~")];
		}
		return dereference(target, targetFile, new Set([...seen, key]));
	}
	return Object.fromEntries(
		await Promise.all(
			Object.entries(schema).map(async ([key, value]) => [
				key,
				await dereference(value, fromFile, seen),
			]),
		),
	);
}

const resolvedSchemas = Object.fromEntries(
	await Promise.all(
		typeSpecs.map(async ([name, file]) => [name, await dereference(schemas[name], file)]),
	),
);

function union(parts) {
	return [...new Set(parts.filter(Boolean))].join(" | ") || "unknown";
}

function tsType(schema, depth = 0) {
	if (!schema || typeof schema !== "object") return "unknown";
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (schema.enum) return union(schema.enum.map((value) => JSON.stringify(value)));
	if (schema.allOf && !schema.type && !schema.properties) {
		return schema.allOf.map((part) => tsType(part, depth)).join(" & ");
	}
	if (schema.oneOf && !schema.type && !schema.properties)
		return union(schema.oneOf.map((part) => tsType(part, depth)));
	if (schema.anyOf && !schema.type && !schema.properties)
		return union(schema.anyOf.map((part) => tsType(part, depth)));
	if ((schema.oneOf || schema.anyOf) && (schema.type || schema.properties)) {
		const { oneOf, anyOf, ...base } = schema;
		return `(${tsType(base, depth)}) & (${union((oneOf ?? anyOf).map((part) => tsType(part, depth)))})`;
	}
	if (Array.isArray(schema.type)) {
		return union(schema.type.map((type) => tsType({ ...schema, type }, depth)));
	}
	if (schema.type === "array") return `Array<${tsType(schema.items ?? {}, depth + 1)}>`;
	if (schema.type === "object" || schema.properties || schema.additionalProperties) {
		const required = new Set(schema.required ?? []);
		const indent = "\t".repeat(depth + 1);
		const closeIndent = "\t".repeat(depth);
		const fields = Object.entries(schema.properties ?? {}).map(
			([key, value]) =>
				`${indent}${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${tsType(value, depth + 1)};`,
		);
		if (schema.additionalProperties === true) fields.push(`${indent}[key: string]: unknown;`);
		if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
			if (fields.length === 0)
				return `Record<string, ${tsType(schema.additionalProperties, depth + 1)}>`;
			fields.push(`${indent}[key: string]: unknown;`);
		}
		return fields.length ? `{\n${fields.join("\n")}\n${closeIndent}}` : "Record<string, unknown>";
	}
	if (schema.type === "string") return "string";
	if (
		schema.type === "integer" &&
		Number.isInteger(schema.minimum) &&
		Number.isInteger(schema.maximum) &&
		schema.maximum - schema.minimum <= 10
	) {
		return union(
			Array.from({ length: schema.maximum - schema.minimum + 1 }, (_, index) =>
				String(schema.minimum + index),
			),
		);
	}
	if (schema.type === "integer" || schema.type === "number") return "number";
	if (schema.type === "boolean") return "boolean";
	if (schema.type === "null") return "null";
	return "unknown";
}

function fixture(schema) {
	if (!schema || typeof schema !== "object") return null;
	if (schema.const !== undefined) return schema.const;
	if (schema.enum) return schema.enum.find((value) => value !== null) ?? null;
	if (schema.allOf && !schema.type && !schema.properties) {
		return Object.assign({}, ...schema.allOf.map(fixture));
	}
	if ((schema.oneOf || schema.anyOf) && !schema.type && !schema.properties) {
		return fixture((schema.oneOf ?? schema.anyOf)[0]);
	}
	const type = Array.isArray(schema.type)
		? schema.type.find((value) => value !== "null")
		: schema.type;
	if (type === "object" || schema.properties) {
		const fixtureKeys = new Set([
			...(schema.required ?? []),
			...Object.entries(schema.properties ?? {})
				.filter(([, property]) => property.const !== undefined)
				.map(([key]) => key),
		]);
		const base = Object.fromEntries(
			[...fixtureKeys].map((key) => [key, fixture(schema.properties?.[key] ?? {})]),
		);
		return Object.assign(
			base,
			schema.oneOf || schema.anyOf ? fixture((schema.oneOf ?? schema.anyOf)[0]) : {},
		);
	}
	if (type === "array")
		return Array.from({ length: schema.minItems ?? 0 }, () => fixture(schema.items ?? {}));
	if (type === "string") {
		if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
		if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000000";
		if (schema.pattern?.includes("|fleet")) return "fleet";
		if (schema.pattern?.includes("\\.")) return "fixture.value";
		return "fixture";
	}
	if (type === "integer" || type === "number") return schema.minimum ?? 0;
	if (type === "boolean") return false;
	return null;
}

const validationKeywords = new Set([
	"type",
	"const",
	"enum",
	"allOf",
	"oneOf",
	"anyOf",
	"if",
	"then",
	"else",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"pattern",
	"format",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"minItems",
	"maxItems",
	"minProperties",
	"maxProperties",
	"uniqueItems",
]);

function compactSchema(schema, propertyMap = false) {
	if (Array.isArray(schema)) return schema.map((item) => compactSchema(item));
	if (!schema || typeof schema !== "object") return schema;
	return Object.fromEntries(
		Object.entries(schema)
			.filter(([key]) => propertyMap || validationKeywords.has(key))
			.map(([key, value]) => [key, compactSchema(value, key === "properties")]),
	);
}

const validatorSource = `
export interface ValidationResult {
\tvalid: boolean;
\terrors: string[];
}

function validateSchema(schema: SchemaNode, value: unknown, path = "$", errors: string[] = []): string[] {
\tif (schema === true) return errors;
\tif (schema === false) { errors.push(path + " is forbidden by the contract"); return errors; }
\tif (schema.const !== undefined && value !== schema.const) errors.push(path + " must equal " + JSON.stringify(schema.const));
\tif (schema.enum && !schema.enum.some((item: unknown) => Object.is(item, value))) errors.push(path + " is not in the contract enum");
\tfor (const child of schema.allOf ?? []) validateSchema(child, value, path, errors);
\tconst alternatives = schema.oneOf ?? schema.anyOf;
\tif (alternatives && !alternatives.some((child: SchemaNode) => validateSchema(child, value, path, []).length === 0)) errors.push(path + " does not match an allowed contract shape");
\tconst allowed = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
\tif (allowed.length) {
\t\tconst actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
\t\tif (!allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) {
\t\t\terrors.push(path + " must be " + allowed.join(" or "));
\t\t\treturn errors;
\t\t}
\t}
\tif (typeof value === "string") {
\t\tif (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(path + " does not match " + schema.pattern);
\t\tif (schema.minLength !== undefined && value.length < schema.minLength) errors.push(path + " is too short");
\t\tif (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(path + " is too long");
\t}
\tif (typeof value === "number") {
\t\tif (schema.minimum !== undefined && value < schema.minimum) errors.push(path + " is below the minimum");
\t\tif (schema.maximum !== undefined && value > schema.maximum) errors.push(path + " exceeds the maximum");
\t}
\tif (Array.isArray(value)) {
\t\tif (schema.minItems !== undefined && value.length < schema.minItems) errors.push(path + " has too few items");
\t\tif (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(path + " has too many items");
\t\tconst itemSchema = schema.items;
\t\tif (itemSchema) value.forEach((item, index) => validateSchema(itemSchema, item, path + "[" + String(index) + "]", errors));
\t}
\tif (value !== null && typeof value === "object" && !Array.isArray(value)) {
\t\tconst record = value as Record<string, unknown>;
\t\tfor (const key of schema.required ?? []) if (!(key in record)) errors.push(path + "." + key + " is required");
\t\tfor (const [key, item] of Object.entries(record)) {
\t\t\tif (schema.properties?.[key]) validateSchema(schema.properties[key], item, path + "." + key, errors);
\t\t\telse if (schema.additionalProperties === false) errors.push(path + "." + key + " is not allowed");
\t\t\telse if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateSchema(schema.additionalProperties, item, path + "." + key, errors);
\t\t}
\t}
\treturn errors;
}`;

const schemaType = `type JsonSchema = Record<string, unknown> & {
\ttype?: string | string[];
\tconst?: unknown;
\tenum?: unknown[];
\tallOf?: SchemaNode[];
\toneOf?: SchemaNode[];
\tanyOf?: SchemaNode[];
\tproperties?: Record<string, SchemaNode>;
\trequired?: string[];
\tadditionalProperties?: SchemaNode;
\titems?: SchemaNode;
\tpattern?: string;
\tminLength?: number;
\tmaxLength?: number;
\tminimum?: number;
\tmaximum?: number;
\tminItems?: number;
\tmaxItems?: number;
};
type SchemaNode = JsonSchema | boolean;`;

const aliases = [
	["SignalSeverity", schemas.SignalEmission.properties.severity],
	["AttentionGrade", schemas.AttentionItem.properties.grade],
	["BudgetLightColor", schemas.GovernanceItem.properties.light],
	["TaskStatus", schemas.TaskItem.properties.status],
];

const nested = [];

const querySchema = clone(schemas.QueryResult);
void querySchema;
const requestSchema = await readJson("schemas/query-request.schema.json");
requestSchema.properties.mode = { const: "structured" };
requestSchema.required = [...new Set([...requestSchema.required, "from"])];

const generatedTypeSchemas = clone(resolvedSchemas);
generatedTypeSchemas.CardItem.required = generatedTypeSchemas.CardItem.required.filter(
	(key) => key !== "delivered" && key !== "addressed",
);
generatedTypeSchemas.ConsoleHealth.properties.bridges.items = {};
generatedTypeSchemas.AttentionItem.properties.blast_radius.properties.host = {
	type: ["string", "null"],
};

const typeFile = `/**
 * GENERATED by scripts/generate-contracts.mjs from console-api JSON Schemas.
 * Do not edit by hand; run \`pnpm --filter console contracts:generate\`.
 */
${schemaType}

export type Lane = ${catalog.lanes.map((lane) => JSON.stringify(lane)).join(" | ")};
${aliases.map(([name, schema]) => `export type ${name} = ${tsType(schema)};`).join("\n")}

export interface ReadEnvelope<T extends Record<string, unknown>> extends Record<string, unknown> {
\tschema_version: 1;
\tfreshness: { source: string; observed_at: string; window_s?: number | null; [key: string]: unknown };
\titems: T[];
\tnext_cursor: string | null;
\ttotal?: number | null;
\ttruncated?: boolean;
}
export type StructuredQuery = ${tsType(requestSchema)};
${nested.map(([name, schema]) => `export type ${name} = ${tsType(schema)};`).join("\n")}
${typeSpecs
	.filter(([name]) => name !== "Principal")
	.map(
		([name]) =>
			`export type ${name} = ${tsType(generatedTypeSchemas[name])}${name === "RosterItem" ? ` & { sources?: Record<"fleet" | "heartbeat" | "registry" | "governance" | "identity" | "lease", { visibility: "visible" | "absent" | "unavailable"; observed_at: string | null }> }` : ""};`,
	)
	.join("\n")}

export type GovernancePool = {
\tpool_tokens: number; pool_spent: number; fleet_mode: "parallel" | "sequential"; cascade_active: boolean; [key: string]: unknown;
};
const CONTRACT_SCHEMAS = ${JSON.stringify(Object.fromEntries(Object.entries(resolvedSchemas).map(([name, schema]) => [name, compactSchema(schema)])))} as unknown as Record<ContractType, JsonSchema>;
export type ContractType = ${typeSpecs.map(([name]) => JSON.stringify(name)).join(" | ")};
/** @public Generated compatibility fixtures for contract consumers and tests. */
export const CONTRACT_FIXTURES = ${JSON.stringify(Object.fromEntries(typeSpecs.map(([name]) => [name, fixture(resolvedSchemas[name])])), null, "\t")} as const;
${validatorSource}

/** @public Validate an API value against its canonical schema. */
export function validateContract(type: ContractType, value: unknown): ValidationResult {
\tconst errors = validateSchema(CONTRACT_SCHEMAS[type], value);
\treturn { valid: errors.length === 0, errors };
}
`;

const verbs = {
	"stats.query": "Re-run",
	"viz.render": "Regenerate",
	"dashboard.save": "Save",
	"dashboard.load": "Load",
	"dashboard.delete": "Delete",
	"agent.restart": "Restart",
	"task.dispatch": "Dispatch",
	"task.claim": "Claim",
	"task.update": "Update",
	"task.close": "Close",
	"governance.action": "Pause",
	"governance.tier": "Tier",
	"signal.snooze": "Quiet 1h",
	"attention.ack": "Ack",
	"attention.snooze": "Snooze",
	"attention.resolve": "Done",
	"term.watch": "Watch session",
	"term.attach": "Attach",
	"term.detach": "Detach",
	"agent.stop": "Stop",
	"dashboard.set_home": "Set as home",
	"dashboard.pin": "Pin to home",
	"updates.check": "Check now",
	"updates.approve": "Approve",
	"updates.revoke": "Revoke approval",
	"updates.apply": "Apply now",
	"host.reboot": "Reboot",
	"edge.enroll.approve": "Approve enrollment",
	"edge.enroll.deny": "Deny",
	"doorman.session.drop": "Drop session",
	"doorman.redial": "Redial",
	"subscription.set": "Save",
	"subscription.remove": "Remove",
	"card.repost": "Re-post",
	"card.park": "Park",
	"delivery.test": "Send a test",
	"delivery.set_target": "Change target",
	"delivery.resend": "Resend",
	"delivery.cocoon": "Until 07:00",
};
const defaultVerb = (op) => {
	const word = op.split(".").at(-1).replaceAll("_", " ");
	return word[0].toUpperCase() + word.slice(1);
};

const resolvedOps = await Promise.all(
	catalog.ops.map(async (entry) => ({
		...entry,
		args: await dereference(entry.args, "ops.json"),
	})),
);
const opRows = resolvedOps.map((entry) => ({
	op: entry.op,
	verb: verbs[entry.op] ?? defaultVerb(entry.op),
	lane: entry.lane,
	executor: entry.executor,
	confirm: entry.confirm === "typed-name" ? "hard" : (entry.confirm ?? "none"),
	undo: entry.undo ?? false,
	humanOnly: entry.human_only ?? false,
	args: compactSchema(entry.args),
}));

const opFile = `/**
 * GENERATED by scripts/generate-contracts.mjs from console-api/docs/contracts/ops.json.
 * Wire metadata and argument schemas are canonical; only button verbs are UI-owned.
 */
import type { Lane } from "./types";

${schemaType}
export type ConfirmKind = "none" | "soft" | "hard";
export type OpName = ${catalog.ops.map((entry) => JSON.stringify(entry.op)).join(" | ")};
export interface OpDef {
\top: OpName; verb: string; lane: Lane; executor: string; confirm: ConfirmKind;
\tundo: boolean; humanOnly: boolean; args: JsonSchema;
}

const OPS: Record<OpName, OpDef> = JSON.parse(${JSON.stringify(JSON.stringify(Object.fromEntries(opRows.map((row) => [row.op, row]))))}) as Record<OpName, OpDef>;
/** @public Generated valid arguments for compatibility tests and downstream consumers. */
export const OP_TEST_FIXTURES = ${JSON.stringify(Object.fromEntries(resolvedOps.map((entry) => [entry.op, fixture(entry.args)])), null, "\t")} as const satisfies Record<OpName, unknown>;
${validatorSource}

export function opDef(op: string): OpDef | undefined { return (OPS as Record<string, OpDef>)[op]; }
export function canSeeOp(op: OpDef, lanes: string[]): boolean { return lanes.includes(op.lane); }
/** @public Validate operation arguments against the canonical catalog schema. */
export function validateOpArgs(op: string, args: unknown): ValidationResult {
\tconst def = opDef(op);
\tif (!def) return { valid: false, errors: [\`Unknown operation: ${"${op}"}\`] };
\tconst errors = validateSchema(def.args, args);
\treturn { valid: errors.length === 0, errors };
}
`;

async function emit(relative, content) {
	const file = path.join(outDir, relative);
	const normalized = `${content.trim()}\n`;
	if (check) {
		const existing = await readFile(file, "utf8").catch(() => "");
		if (existing !== normalized)
			throw new Error(`${path.relative(consoleDir, file)} is stale; run contracts:generate`);
	} else {
		await writeFile(file, normalized);
	}
}

await emit("types.ts", typeFile);
await emit("ops.ts", opFile);
