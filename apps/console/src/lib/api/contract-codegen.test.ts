import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OP_TEST_FIXTURES, opDef, validateOpArgs } from "./ops.ts";
import { CONTRACT_FIXTURES, validateContract, type ContractType } from "./types.ts";

describe("generated API contracts", () => {
	it("has no canonical-source drift in generated contract files", () => {
		execFileSync(process.execPath, ["scripts/generate-contracts.mjs", "--check"], {
			cwd: fileURLToPath(new URL("../../../", import.meta.url)),
			stdio: "pipe",
		});
	});

	it("gives every canonical op metadata and a valid generated fixture", () => {
		for (const [op, args] of Object.entries(OP_TEST_FIXTURES)) {
			expect(opDef(op), `${op} must be displayable`).toBeTruthy();
			expect(validateOpArgs(op, args)).toEqual({ valid: true, errors: [] });
		}
	});

	it("rejects incompatible contract changes", () => {
		expect(validateOpArgs("attention.ack", {}).valid).toBe(false);
		expect(validateOpArgs("not.an.op", {}).valid).toBe(false);
		expect(validateContract("ConsoleHealth", { lake: "ok" }).valid).toBe(false);
	});

	it("validates every generated API fixture against its source schema", () => {
		for (const [name, fixture] of Object.entries(CONTRACT_FIXTURES)) {
			expect(validateContract(name as ContractType, fixture)).toEqual({
				valid: true,
				errors: [],
			});
		}
	});
});
