#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { z } from "zod";

import { Cite, Store } from "./index.ts";
import { normalize } from "./model.ts";

const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const [command, argument, option] = process.argv.slice(2);
let store: Store | undefined;

try {
	store = new Store(process.env["CITE_ROOT"] ?? "/home/docker/vault-data/sources");
	const cite = new Cite(store);

	switch (command) {
		case "add": {
			if (!argument) {
				throw new Error("Usage: cite add <URL|DOI|arXiv ID>");
			}

			if (option && option !== "--refresh") {
				throw new Error("Usage: cite add <ref> [--refresh]");
			}

			const result = await cite.add(argument, option === "--refresh");

			emit(result);

			if (!result.source) {
				process.exitCode = 1;
			}

			break;
		}
		case "get": {
			if (!argument) {
				throw new Error("Usage: cite get <ref|src-id>");
			}

			const ref = argument.startsWith("src-") ? argument : normalize(argument);
			const source = store.get(ref);

			emit(
				source
					? { source, derivation: store.derivation(source.id), history: store.history(ref) }
					: {
							citation: store.citation(ref) ?? { status: "NOT_FOUND" },
							history: store.history(ref),
						},
			);

			if (!source) {
				process.exitCode = 1;
			}

			break;
		}
		case "search":
			if (argument) {
				emit(store.search(argument));
			} else {
				throw new Error("Usage: cite search <FTS5 query>");
			}

			break;
		case "status":
			emit(store.status());

			break;
		case "derive":
			emit(
				await cite.derive(
					argument ? z.coerce.number().int().min(1).max(1000).parse(argument) : 100,
				),
			);

			break;
		case "work":
			emit(
				await cite.work(
					undefined,
					argument ? z.coerce.number().int().min(1).max(1000).parse(argument) : 100,
				),
			);

			emit(await cite.derive());

			break;
		case "backfill": {
			if (!argument || (option && option !== "--rest")) {
				throw new Error("Usage: cite backfill <csv> [--rest]");
			}

			emit(cite.backfill(argument, option === "--rest" ? "rest" : "papers"));
			emit(await cite.work());
			emit(await cite.derive());

			break;
		}
		case "hook": {
			const event = z
				.object({ tool_name: z.string(), tool_input: z.object({ url: z.string() }) })
				.parse(JSON.parse(readFileSync(0, "utf8")));

			if (event.tool_name !== "WebFetch") {
				throw new Error("Unsupported fetch hook; use Cite.add in the harness adapter");
			}

			const result = await cite.add(event.tool_input.url);

			process.stderr.write(`${JSON.stringify(result.counts)}\n`);

			emit({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: result.source ? "allow" : "deny",
					permissionDecisionReason: result.source
						? `Captured source:: [[${result.source.id}]]`
						: "Primary source capture incomplete",
				},
			});

			break;
		}
		case undefined: {
			throw new Error("Usage: cite add|get|search|status|backfill|work|derive|hook");
		}
		default:
			throw new Error("Usage: cite add|get|search|status|backfill|work|derive|hook");
	}
} catch (error) {
	emit({ status: "FAILED", reason: error instanceof Error ? error.message : "Command failed" });
	process.exitCode = command === "hook" ? 2 : 1;
} finally {
	store?.close();
}
