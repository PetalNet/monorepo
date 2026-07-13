import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OP_TEST_FIXTURES, opDef, validateOpArgs } from "./ops.ts";
import { CONTRACT_FIXTURES, validateContract, type ContractType } from "./types.ts";

test("generated contract files have no canonical-source drift", () => {
	execFileSync(process.execPath, ["scripts/generate-contracts.mjs", "--check"], {
		cwd: fileURLToPath(new URL("../../../", import.meta.url)),
		stdio: "pipe",
	});
});

test("every canonical op has metadata and a valid generated fixture", () => {
	for (const [op, args] of Object.entries(OP_TEST_FIXTURES)) {
		assert.ok(opDef(op), `${op} must be displayable`);
		assert.deepEqual(validateOpArgs(op, args), { valid: true, errors: [] });
	}
});

test("generated validators reject incompatible contract changes", () => {
	assert.equal(validateOpArgs("attention.ack", {}).valid, false);
	assert.equal(validateOpArgs("not.an.op", {}).valid, false);
	assert.equal(validateContract("ConsoleHealth", { lake: "ok" }).valid, false);
});

test("every generated API fixture validates against its source schema", () => {
	for (const [name, fixture] of Object.entries(CONTRACT_FIXTURES)) {
		assert.deepEqual(validateContract(name as ContractType, fixture), { valid: true, errors: [] });
	}
});
