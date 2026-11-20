import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Schema } from "effect";

import { ScannerUnavailable } from "./errors.ts";
import { secretRules } from "./secrets.ts";

const MAX_BYTES = 16 * 1024 * 1024;
const PROVIDER_TIMEOUT = 15_000;
const Nonempty = Schema.String.check(Schema.isMinLength(1));
const Argv = Schema.NonEmptyArray(Nonempty);
const Fields = Schema.Record(Nonempty, Schema.String);
const Provider = Schema.Record(Nonempty, Schema.Union([Schema.String, Fields]));
const Policy = Schema.Struct({
	skipEntries: Schema.optionalKey(Schema.Array(Nonempty)),
	skipFields: Schema.optionalKey(Schema.Array(Schema.Struct({ entry: Nonempty, field: Nonempty }))),
	skipShortValues: Schema.optionalKey(Schema.Boolean),
	skipPaths: Schema.optionalKey(Schema.Boolean),
	skipUrls: Schema.optionalKey(Schema.Boolean),
});

/** Safe rule IDs only; the scanner never returns values or the entries that supplied them. */
export type OutboundScanner = (texts: Iterable<string>) => string[];

const decode = <A>(schema: Schema.Decoder<A>, text: string): A =>
	Schema.decodeSync(Schema.fromJsonString(schema))(text, { onExcessProperty: "error" });

/** Collects a bounded UTF-8 stream without staging its bytes on disk. */
export async function readScanInput(stream: AsyncIterable<Uint8Array>): Promise<string> {
	const chunks: Uint8Array[] = [];
	let size = 0;

	try {
		for await (const chunk of stream) {
			size += chunk.byteLength;

			if (size > MAX_BYTES) {
				throw new ScannerUnavailable();
			}

			chunks.push(chunk);
		}

		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	} catch {
		throw new ScannerUnavailable();
	}
}

function providerOutput(
	argv: readonly [string, ...string[]],
	env: NodeJS.ProcessEnv,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const [command, ...args] = argv;
		const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "ignore"] });
		const timeout = setTimeout(() => {
			child.stdout.destroy();
			child.kill("SIGKILL");
			reject(new ScannerUnavailable());
		}, PROVIDER_TIMEOUT);

		child.once("error", () => {
			clearTimeout(timeout);
			reject(new ScannerUnavailable());
		});

		const output = readScanInput(child.stdout);

		// Observe stream rejection immediately; waiting for exit first can deadlock a full pipe.
		void output.catch(() => {
			child.kill("SIGKILL");
		});

		child.once("close", (code) => {
			clearTimeout(timeout);

			if (code === 0) {
				resolve(output);
			} else {
				reject(new ScannerUnavailable());
			}
		});
	});
}

const isPath = (value: string) =>
	/^(?:\/(?!\/)|~\/|\.\.?\/|[a-z]:[\\/]|\\\\)[^\r\n]+$/i.test(value);

function isPublicUrl(value: string): boolean {
	try {
		const url = new URL(value);

		return (
			/^https?:\/\//i.test(value) &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === "" &&
			secretRules([value]).length === 0
		);
	} catch {
		return false;
	}
}

/**
 * Loads known values once on the agent host. Provider output and the resulting comparison set
 * remain in memory; no names, fingerprints or values are exposed by the returned function.
 */
export async function loadOutboundScanner(
	env: NodeJS.ProcessEnv = process.env,
): Promise<OutboundScanner> {
	try {
		const argv = decode(Argv, env["VAULT_SECRET_PROVIDER_ARGV"] ?? "");
		const policyFile = env["VAULT_SECRET_POLICY"];

		if (policyFile !== undefined && !path.isAbsolute(policyFile)) {
			throw new ScannerUnavailable();
		}

		const policy = decode(
			Policy,
			policyFile === undefined ? "{}" : await readFile(policyFile, "utf8"),
		);
		const entries = Object.entries(decode(Provider, await providerOutput(argv, env)));

		if (entries.length === 0) {
			throw new ScannerUnavailable();
		}

		const known = new Set<string>();

		for (const [entry, fields] of entries) {
			const values: [string, string][] =
				typeof fields === "string" ? [["value", fields]] : Object.entries(fields);

			if (values.length === 0) {
				throw new ScannerUnavailable();
			}

			for (const [field, value] of values) {
				if (
					value === "" ||
					policy.skipEntries?.includes(entry) === true ||
					policy.skipFields?.some((skip) => skip.entry === entry && skip.field === field) ===
						true ||
					((policy.skipShortValues ?? true) && value.length < 8) ||
					((policy.skipPaths ?? true) && isPath(value)) ||
					((policy.skipUrls ?? true) && isPublicUrl(value))
				) {
					continue;
				}

				known.add(value);
			}
		}

		return (texts) => {
			const candidates = [...texts];
			const rules = secretRules(candidates);

			if ([...known].some((value) => candidates.some((text) => text.includes(value)))) {
				rules.push("known-secret");
			}

			return rules;
		};
	} catch {
		throw new ScannerUnavailable();
	}
}
