#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";

import { capabilityAcquisitionSchema } from "../src/lib/server/domain/registry/acquisition.ts";
import {
	installCapabilityBundle,
	parseCapabilityBundle,
} from "../src/lib/server/domain/registry/loader.ts";

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
	const capability = process.argv[2];
	if (!capability || capability.startsWith("--"))
		throw new Error("usage: console-api-acquire <capability> [--provider <id>] [--root <dir>]");
	const base = (
		process.env["CONSOLE_API_URL"] ?? "https://console-api.petalcat.dev/api/v1"
	).replace(/\/$/, "");
	const token = process.env["CONSOLE_API_TOKEN"];
	if (!token) throw new Error("CONSOLE_API_TOKEN is required");
	const provider = argument("--provider");
	const response = await fetch(
		`${base}/library/capabilities/${encodeURIComponent(capability)}/acquire`,
		{
			method: "POST",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(provider ? { provider } : {}),
		},
	);
	if (!response.ok) {
		const failure = (await response.json().catch(() => null)) as {
			error?: { message?: string };
		} | null;
		throw new Error(
			failure?.error?.message ?? `capability acquisition failed (${response.status})`,
		);
	}
	const parsed = capabilityAcquisitionSchema.safeParse(await response.json());
	if (!parsed.success) throw new Error("capability acquisition response is invalid");
	const acquisition = parsed.data;
	if (acquisition.capability !== capability)
		throw new Error("capability acquisition response is invalid");
	if (provider && acquisition.provider !== provider)
		throw new Error("capability acquisition provider does not match the request");
	const artifactBytes = Buffer.from(acquisition.artifact.data, "base64");
	if (artifactBytes.length !== acquisition.artifact.bytes)
		throw new Error("capability acquisition byte count is invalid");
	const bundle = parseCapabilityBundle(artifactBytes, acquisition.integrity);
	const root = resolve(argument("--root") ?? process.env["CODEX_HOME"] ?? `${homedir()}/.codex`);
	const receipt = await installCapabilityBundle(bundle, {
		root,
		capability: acquisition.capability,
		kind: acquisition.kind,
		version: acquisition.version,
	});
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "capability acquisition failed"}\n`,
	);
	process.exitCode = 1;
});
