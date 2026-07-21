import assert from "node:assert/strict";

import { test } from "vitest";

import opCatalogJson from "../../../docs/contracts/ops.json" with { type: "json" };
import { OP_TEST_FIXTURES, opDef, validateOpArgs } from "./ops.ts";
import { CONTRACT_FIXTURES, validateContract, type ContractType } from "./types.ts";

test("the op-name union covers exactly the canonical catalog", () => {
	const catalogOps = (opCatalogJson as { ops: { op: string }[] }).ops.map((entry) => entry.op);
	assert.deepEqual(Object.keys(OP_TEST_FIXTURES).toSorted(), catalogOps.toSorted());
});

test("every canonical op has metadata and a valid fixture", () => {
	for (const [op, args] of Object.entries(OP_TEST_FIXTURES)) {
		assert.ok(opDef(op), `${op} must be displayable`);
		assert.deepEqual(validateOpArgs(op, args), { valid: true, errors: [] }, op);
	}
});

test("the validators reject incompatible contract payloads", () => {
	assert.equal(validateOpArgs("attention.ack", {}).valid, false);
	assert.equal(validateOpArgs("attention.ack", { id: "x", extra: true }).valid, false);
	assert.equal(validateOpArgs("not.an.op", {}).valid, false);
	assert.equal(validateContract("ConsoleHealth", { lake: "ok" }).valid, false);
	assert.equal(validateContract("UpdateApproval", { approval_id: "not-a-uuid" }).valid, false);
});

test("server->client validation ignores unknown keys (open shapes)", () => {
	const fixture = { ...CONTRACT_FIXTURES.ConsoleHealth, some_future_field: 1 };
	assert.deepEqual(validateContract("ConsoleHealth", fixture), { valid: true, errors: [] });
});

test("every API fixture validates against its Effect Schema", () => {
	for (const [name, fixture] of Object.entries(CONTRACT_FIXTURES)) {
		assert.deepEqual(
			validateContract(name as ContractType, fixture),
			{ valid: true, errors: [] },
			name,
		);
	}
});
