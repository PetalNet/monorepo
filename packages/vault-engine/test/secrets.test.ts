import { describe, expect, it } from "@effect/vitest";

import { secretRules } from "../src/secrets.ts";

describe("secret scan", () => {
	it("does not treat ordinary prose about keys and tokens as a secret", () => {
		expect(
			secretRules(["token: /home/agent/.claude/shared/github-pat, key = per-claim-retrieval"]),
		).toEqual([]);

		expect(
			secretRules([`api_key = "${["9f8e7d6c", "5b4a3f2e", "1d0c9b8a", "7f6e5d4c"].join("")}"`]),
		).toEqual(["generic-api-key"]);
	});
});

describe("secret rules", () => {
	it.each([
		["a password with punctuation", `DB_PASSWORD=${["Xk9pQ2", "vL7mWz!"].join("")}`],
		["a quoted password", `password: '${["Tq7#mZ2", "@vR9k"].join("")}'`],
		["a JSON secret", `{"secret":"${["3f9a2b1c", "8d7e6f50", "a1b2c3d4", "e5f60718"].join("")}"}`],
		["a token header", `Authorization: Token ${["9f8e7d6c5b4a", "3f2e1d0c9b8a"].join("")}`],
		[
			"a Proxmox API token",
			`PVEAPIToken=root@pam!janet=${["3f9a2b1c-8d7e", "-4f50-a1b2-c3d4e5f60718"].join("")}`,
		],
		["a Hugging Face token", `hf_${"aB3dE6gH9j".repeat(3)}xyz`],
		[
			"a Matrix token for a short user name",
			["syt", "amFuZXQ", "aBcDeFgHiJkLmNoPqRsT", "1a2B3c"].join("_"),
		],
		["a TOTP seed", ["otpauth://totp/Lab:janet?sec", "ret=JBSWY3DPEHPK3PXP"].join("")],
		["a passphrase", `passphrase: ${["correct7", "horse9battery"].join("-")}`],
	])("flags %s", (_, text) => {
		expect(secretRules([text])).not.toEqual([]);
	});

	it.each([
		["a file path after a keyword", "token: /home/agent/.claude/shared/github-pat2"],
		["a URL after a keyword", "api key: https://example.org/docs/v2/keys"],
		["prose about keys", "The retrieval key: per-claim indexing, see section 3."],
		["a claim ID", "key claim c-7f3k2abc supports this"],
	])("leaves %s alone", (_, text) => {
		expect(secretRules([text])).toEqual([]);
	});
});
