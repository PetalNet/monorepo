import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verdict } from "./matrix-secret-guard.ts";

const SEND = "mcp__hermes-link__send_message";
const FILE = "mcp__hermes-link__send_file";
const send = (text: string, tool = SEND) => ({
	tool_name: tool,
	tool_input:
		tool === FILE ? { room: "!r:x", path: "/tmp/a", caption: text } : { room: "!r:x", text },
});
const sendFile = (path: string, caption = "here") => ({
	tool_name: FILE,
	tool_input: { room: "!r:x", path, caption },
});
const raw = (content: unknown) => ({
	tool_name: "mcp__hermes-link__raw",
	tool_input: { action: "send_event", room: "!r:x", event_type: "m.room.message", content },
});
const poll = (question: string, answers: string[]) => ({
	tool_name: "mcp__hermes-link__poll",
	tool_input: { room: "!r", action: "start", question, answers },
});
const cat = (...parts: string[]) => parts.join("");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

// Built from pieces so this file does not itself look like a leaked secret.
const GHP = cat("ghp_", "q1W2e3R4t5Y6u7I8o9P0a1S2d3F4g5H6j7K8");
const SECRETS: Record<string, string> = {
	ghp: `here ${GHP}`,
	pat: cat("github_pat_", "11ZYXWVUT0zyxwvutsrq_ponmlkjihgfedcba9876543210ZYXWVU"),
	sk: cat("use sk-", "proj-Lm4Nb5Vc6Xz7", "Qa8Ws9Ed1Rf2Tg3Yh4"),
	slack: cat("xoxb-", "210987654321-zyxwvuZYXWVU98"),
	aws: cat("AKIA", "ABCDEFGHIJKLMNOP"),
	jwt: [b64({ alg: "HS256" }), b64({ sub: "demo" }), "Qa1Ws2Ed3Rf4Tg5Yh6Uj7Ik8Ol9Pz0Xc"].join("."),
	pem: cat("-----BEGIN ", "OPENSSH PRIVATE KEY", "-----"),
	hex: cat("api key: ", "0123456789abcdef0123456789abcdefdeadbeef"),
	b64: cat("password=", "cXV1eGNvcmdlZ3JhdWx0MTIzNDU2Nzg5MGFiY2RlZmdoaWo="),
	quoted: cat('client_secret: "', "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp", '"'),
	bearer: cat("Authorization: Bearer ", "zyxwvu9876543210zyxwvu9876543210zyxw"),
	matrix: cat("syt_", "ZGVtb2FjY2Vzc3Rva2Vu_AbCdEf_0123"),
};

const PASSED: [string, string][] = [
	["an event id", "replied to $Xk3JmQ9v2LbN7rT4yHcP0aWdEfGiUoZsB5nMq81VtRA"],
	["an mxc url", "file mxc://example.org/AbCdEfGhIjKlMnOpQrStUvWx"],
	["a bare commit hash", "commit 4f9c2ab7e1d3f5a6b8c0d2e4f6a8b0c2d4e6f8a0 is merged"],
	["key words in prose", "the token budget resets at 5pm; password manager is fine; secret santa"],
	["a long hyphenated slug", "risk-assessment-framework-for-the-task-management-system"],
	["another long slug", "task-queue-processing-status-is-green-today"],
	["a sync token that is an event id", "sync token: $Xk3JmQ9v2LbN7rT4yHcP0aWdEfGiUoZsB5nMq81VtRA"],
	[
		"urls and a path to a credential file",
		"see https://example.org/org/repo/pull/31 and /srv/app/shared/github-pat",
	],
	["a bare AWS prefix", "AKIA is the prefix"],
	["a bare GitHub prefix", "ghp_ tokens are classic PATs"],
	["near-miss words", "# header\nplain text with a skill-name and xoxo hugs"],
	["a certificate", cat("-----BEGIN ", "CERTIFICATE", "-----")],
	["a public key", cat("-----BEGIN ", "PUBLIC KEY", "-----")],
];

describe("matrix-secret-guard verdict", () => {
	it.each(Object.entries(SECRETS))(
		"denies %s in send_message and a send_file caption",
		(_k, text) => {
			expect(verdict(send(text))).toMatch(/vault|secret-drop|redact/iu);
			expect(verdict(send(text, FILE))).toMatch(/^BLOCKED: this Matrix message/u);
		},
	);

	it("names the kind of secret without echoing it", () => {
		const why = verdict(send(SECRETS["ghp"] ?? ""));

		expect(why).toContain("(GitHub token)");
		expect(why).not.toContain("q1W2e3R4t5Y6");
	});

	it.each(PASSED)("passes %s", (_name, text) => {
		expect(verdict(send(text))).toBeNull();
		expect(verdict(send(text, FILE))).toBeNull();
	});

	it("denies a credential file path and passes an ordinary one", () => {
		expect(verdict(sendFile("/srv/app/shared/github-pat"))).toMatch(/credential file/u);
		expect(verdict(sendFile("/srv/app/.env.prod"))).toMatch(/credential file/u);
		expect(verdict(sendFile("/home/me/id_ed25519"))).toMatch(/credential file/u);
		expect(verdict(sendFile("/home/me/api-token.txt"))).toMatch(/credential file/u);
		expect(verdict(sendFile("/home/me/report.pdf"))).toBeNull();
	});

	it("scans raw content and body at any depth", () => {
		expect(verdict(raw({ msgtype: "m.text", body: GHP }))).toMatch(/secret/iu);

		expect(
			verdict({
				tool_name: "mcp__hermes-link__raw",
				tool_input: { action: "http", method: "PUT", path: "/_matrix/x", body: { body: GHP } },
			}),
		).toMatch(/secret/iu);
	});

	it("scans a poll question and its answers", () => {
		expect(verdict(poll(`is ${GHP} ok`, ["a", "b"]))).toMatch(/secret/iu);
		expect(verdict(poll("which", ["yes", GHP]))).toMatch(/secret/iu);
	});

	it("passes ordinary raw and poll calls", () => {
		expect(
			verdict(
				raw({ msgtype: "m.text", body: "hello $Xk3JmQ9v2LbN7rT4yHcP0aWdEfGiUoZsB5nMq81VtRA" }),
			),
		).toBeNull();

		expect(
			verdict({
				tool_name: "mcp__hermes-link__raw",
				tool_input: { action: "http", method: "GET", path: "/_matrix/client/v3/joined_rooms" },
			}),
		).toBeNull();

		expect(verdict(poll("Lunch?", ["Pizza", "Tacos"]))).toBeNull();

		expect(
			verdict({
				tool_name: "mcp__hermes-link__poll",
				tool_input: {
					room: "!r",
					action: "end",
					poll_start_id: "$Xk3JmQ9v2LbN7rT4yHcP0aWdEfGiUoZsB5nMq81VtRA",
				},
			}),
		).toBeNull();
	});

	it("passes empty input", () => {
		expect(verdict(null)).toBeNull();
		expect(verdict({})).toBeNull();
	});
});

describe("matrix-secret-guard as a hook process", () => {
	const script = fileURLToPath(new URL("matrix-secret-guard.ts", import.meta.url));
	const run = (stdin: string) => {
		const result = spawnSync(process.execPath, ["--no-warnings", script], {
			input: stdin,
			encoding: "utf8",
		});

		expect(result.status).toBe(0);

		return result.stdout;
	};

	it("prints a deny that names the fix and not the secret", () => {
		const stdout = run(JSON.stringify(send(GHP)));
		const out = JSON.parse(stdout) as {
			hookSpecificOutput: {
				hookEventName: string;
				permissionDecision: string;
				permissionDecisionReason: string;
			};
		};

		expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain("secret-drop tool");
		expect(stdout).not.toContain(GHP);
	});

	it("denies a credential file path", () => {
		expect(run(JSON.stringify(sendFile("/srv/app/shared/github-pat")))).toContain(
			"credential file",
		);
	});

	it("prints nothing for an ordinary message", () => {
		expect(run(JSON.stringify(send("lunch at noon?")))).toBe("");
	});

	it("fails open on bad input", () => {
		expect(run("not json")).toBe("");
		expect(run("null")).toBe("");
	});
});
