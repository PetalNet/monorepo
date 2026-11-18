import { spawnSync } from "node:child_process";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { refresh, vaultApi } from "../src/api.ts";
import { Vault } from "../src/engine.ts";
import { Cite, remember } from "../src/research.ts";
import { readText, seeded, state, stored, tempDir, test, vaultAt, writeText } from "./tools.ts";

const token = `ghp_${"a1B2".repeat(9)}`;

const mcp = (id: number, method: string, params: Record<string, unknown> = {}) =>
	new Request("http://vault.test/mcp", {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": method,
			...(typeof params["name"] === "string" ? { "mcp-name": params["name"] } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method,
			params: {
				...params,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": { name: "vault-test", version: "1.0.0" },
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});

interface ToolResult {
	readonly result: {
		readonly tools?: readonly { readonly name: string }[];
		readonly isError?: boolean;
		readonly structuredContent?: Record<string, unknown>;
	};
}

describe("MCP", () => {
	test("serves the agent operations over Streamable HTTP and refuses a secret-bearing write", () =>
		Effect.gen(function* () {
			const services = Layer.mergeAll(Layer.succeed(Vault, yield* Vault), Cite.layer([])).pipe(
				Layer.provideMerge(NodeServices.layer),
			);
			const { handler, dispose } = HttpRouter.toWebHandler(Layer.mergeAll(vaultApi, services), {
				disableLogger: true,
			});
			const send = (request: Request) =>
				Effect.promise(async () => (await (await handler(request)).json()) as ToolResult);

			yield* seeded;

			const listed = yield* send(mcp(1, "tools/list"));

			expect(listed.result.tools?.map((tool) => tool.name).toSorted()).toEqual([
				"claim_retract",
				"recall",
				"remember",
				"research_check",
				"research_run",
				"source_add",
				"source_retire",
			]);

			const saved = yield* send(
				mcp(2, "tools/call", {
					name: "remember",
					arguments: { text: "A hunch about notes.", topic: "Note granularity" },
				}),
			);
			const found = yield* send(
				mcp(3, "tools/call", { name: "recall", arguments: { query: "hunch" } }),
			);
			const refused = yield* send(
				mcp(4, "tools/call", {
					name: "remember",
					arguments: { text: `push with ${token}`, topic: "Note granularity" },
				}),
			);

			expect(saved.result.isError).toBe(false);

			expect(found.result.structuredContent?.["text"]).toMatch(
				new RegExp(
					String.raw`^\[${String(saved.result.structuredContent?.["id"])}\] Note granularity > Notes: A hunch about notes\.`,
				),
			);

			expect(refused.result).toMatchObject({
				isError: true,
				structuredContent: { error: { code: "operation_failed" } },
			});

			expect(JSON.stringify(refused)).toContain("github-pat");
			expect(JSON.stringify(refused)).not.toContain(token);
			expect(Object.keys((yield* state("shared")).claims)).toHaveLength(1);
			expect(yield* stored("shared")).not.toContain(token);

			yield* Effect.promise(dispose);
		}));
});

describe("refresh", () => {
	test("keeps the saved claim when the read side cannot be refreshed", () =>
		Effect.gen(function* () {
			const blocked = path.join(yield* tempDir, "file");

			yield* writeText(blocked, "not a directory");

			const vault = yield* vaultAt();

			yield* Effect.gen(function* () {
				yield* seeded;
				const claim = yield* remember("shared", { text: "Saved once.", topic: "Note granularity" });

				yield* refresh;
				expect(Object.keys((yield* state("shared")).claims)).toEqual([claim.id]);
			}).pipe(Effect.provideService(Vault, { ...vault, projection: path.join(blocked, "vault") }));
		}));
});

describe("CLI", () => {
	const cli = (root: string, ...args: string[]) =>
		spawnSync(
			process.execPath,
			["--no-warnings", path.join(import.meta.dirname, "../src/cli.ts"), ...args],
			{
				encoding: "utf8",
				env: {
					...process.env,
					VAULT_ROOT: root,
					VAULT_AGENT: "cli-test",
					VAULT_CITE: "",
					VAULT_PROJECTION: path.join(root, "obsidian"),
				},
			},
		);

	test(
		"writes, recalls, projects and refuses through the same operations",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDir;
				const saved = cli(
					root,
					"remember",
					"--topic",
					"Note granularity",
					"A",
					"hunch",
					"about",
					"notes.",
				);

				expect(saved.status).toBe(0);

				expect(JSON.parse(saved.stdout)).toMatchObject({
					text: "A hunch about notes.",
					agent: "cli-test",
				});

				expect(cli(root, "recall", "hunch").stdout).toMatch(
					/^\[c-[a-z0-9]{8}\] Note granularity > Notes: A hunch about notes\./,
				);

				expect(
					yield* readText(root, "obsidian", "shared", "Topics", "Note granularity.md"),
				).toContain("- A hunch about notes. [basis:: GUESS]");

				const refused = cli(root, "remember", "--topic", "Note granularity", `token ${token}`);

				expect(refused.status).toBe(1);
				expect(refused.stderr).toMatch(/Secret scan rejected the write to .*: github-pat/);
				expect(refused.stderr).not.toContain(token);

				expect(JSON.parse(cli(root, "lint").stdout)).toMatchObject({
					problems: [],
					claimBlocks: 1,
				});
			}),
		60_000,
	);
});
