import { readFile } from "node:fs/promises";

import type { SourceId, SourceInfo, SourceRows } from "$lib/api";

import { caFileEnv, type Config, type SourceConfig } from "../config.ts";
import { getJson } from "./http.ts";
import * as normalise from "./normalise.ts";

interface SourceDef {
	label: string;
	/** Paths fetched in parallel; their bodies go to `table` in the same order. */
	paths: (config: SourceConfig) => string[];
	authorization: (secret: string) => string;
	table: (bodies: unknown[]) => normalise.Table | null;
}

export const SOURCES: Record<SourceId, SourceDef> = {
	proxmox: {
		label: "Proxmox",
		paths: ({ node = "" }) => [
			`/api2/json/nodes/${encodeURIComponent(node)}/qemu`,
			`/api2/json/nodes/${encodeURIComponent(node)}/lxc`,
		],
		authorization: (secret) => `PVEAPIToken=${secret}`,
		table: ([qemu, lxc]) => normalise.proxmox(qemu, lxc),
	},
	truenas: {
		label: "TrueNAS",
		// Without extra.pools TrueNAS leaves every disk's pool null.
		paths: () => ["/api/v2.0/disk?extra.pools=true"],
		authorization: (secret) => `Bearer ${secret}`,
		table: ([disks]) => normalise.truenas(disks),
	},
	hass: {
		label: "Home Assistant",
		paths: () => ["/api/states"],
		authorization: (secret) => `Bearer ${secret}`,
		table: ([states]) => normalise.hass(states),
	},
};

export const isSourceId = (value: string): value is SourceId => Object.hasOwn(SOURCES, value);

export function sourceInfo(config: Config): SourceInfo[] {
	return (Object.keys(SOURCES) as SourceId[]).map((id) => ({
		id,
		label: SOURCES[id].label,
		configured: config.sources[id] !== null,
	}));
}

export type SourceResult = { ok: true; rows: SourceRows } | { ok: false; error: string };

/**
 * Read a source with its secret loaded from disk for this request only. Error messages name the
 * source and the failure, never the secret or the reply body.
 */
export async function readSource(
	id: SourceId,
	config: SourceConfig,
	now: () => Date = () => new Date(),
	timeoutMs = 10_000,
): Promise<SourceResult> {
	const def = SOURCES[id];
	let secret: string;

	try {
		secret = (await readFile(config.secretFile, "utf8")).trim();
	} catch {
		return { ok: false, error: `${def.label} credential file could not be read` };
	}

	let ca: string | undefined;

	try {
		ca = config.caFile === undefined ? undefined : await readFile(config.caFile, "utf8");
	} catch {
		return { ok: false, error: `${def.label} CA certificate file could not be read` };
	}

	const headers = { authorization: def.authorization(secret) };
	const results = await Promise.all(
		def.paths(config).map((path) => getJson(`${config.url}${path}`, { headers, ca, timeoutMs })),
	);
	const bodies: unknown[] = [];

	for (const result of results) {
		switch (result.kind) {
			case "unreachable":
				return { ok: false, error: `${def.label} unreachable` };
			case "untrusted":
				return {
					ok: false,
					error: `${def.label} has a certificate this server does not trust; set ${caFileEnv(id)} to its CA certificate if it is self-signed`,
				};
			case "unreadable":
				return { ok: false, error: `${def.label} sent a reply that is not JSON` };
			case "status":
				return {
					ok: false,
					error:
						result.status === 401 || result.status === 403
							? `${def.label} refused the token`
							: `${def.label} answered HTTP ${String(result.status)}`,
				};
			case "ok":
				bodies.push(result.body);
		}
	}

	const table = def.table(bodies);

	return table
		? { ok: true, rows: { ...table, fetchedAt: now().toISOString() } }
		: { ok: false, error: `${def.label} sent a reply in an unexpected shape` };
}
