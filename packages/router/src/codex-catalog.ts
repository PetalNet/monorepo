import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Effort } from "./effort.ts";
import type { Catalog, CatalogModel } from "./pick.ts";
import { locked } from "./state.ts";

const exec = promisify(execFile);
const ALLOWED = new Set(["none", "low", "medium", "high"]);
const HIDDEN = new Set(["gpt-reserve", "codex-auto-review"]);

interface Model {
	slug: string;
	efforts: Effort[];
}
export interface Snapshot {
	client_version: string;
	fetchedAt: number;
	models: Model[];
}
export interface DiscoveryDeps {
	command: (args: string[]) => Promise<string>;
	now: () => number;
}
const defaults: DiscoveryDeps = {
	command: async (args) =>
		(await exec("codex", args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout,
	now: Date.now,
};

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("invalid Codex catalog object");
	return Object.fromEntries(Object.entries(value));
}

export function parseModels(raw: unknown): Model[] {
	const data = object(raw);
	if (!Array.isArray(data["models"])) throw new TypeError("Codex catalog has no models array");
	const models = data["models"].flatMap((entry: unknown): Model[] => {
		const model = object(entry);
		const slug = model["slug"];
		if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9.-]*$/u.test(slug))
			throw new TypeError("invalid Codex model slug");
		if (model["visibility"] !== "list" || HIDDEN.has(slug)) return [];
		if (!Array.isArray(model["supported_reasoning_levels"]))
			throw new TypeError("missing Codex efforts");
		const efforts = model["supported_reasoning_levels"].flatMap((level: unknown): Effort[] => {
			const effort = object(level)["effort"];
			return effort === "none" || effort === "low" || effort === "medium" || effort === "high"
				? [effort]
				: [];
		});
		return efforts.length ? [{ slug, efforts: [...new Set(efforts)] }] : [];
	});
	if (!models.length) throw new TypeError("Codex returned no visible runnable models");
	return [...new Map(models.map((m) => [m.slug, m])).values()];
}

async function cached(file: string): Promise<Snapshot | undefined> {
	try {
		const data = object(JSON.parse(await readFile(file, "utf8")));
		if (
			typeof data["client_version"] !== "string" ||
			typeof data["fetchedAt"] !== "number" ||
			!Number.isFinite(data["fetchedAt"]) ||
			!Array.isArray(data["models"])
		)
			return undefined;
		const models = parseModels({
			models: data["models"].map((entry: unknown) => {
				const m = object(entry);
				if (
					!Array.isArray(m["efforts"]) ||
					!m["efforts"].every((e: unknown) => typeof e === "string" && ALLOWED.has(e))
				)
					throw new TypeError("invalid cached efforts");
				return {
					slug: m["slug"],
					visibility: "list",
					supported_reasoning_levels: m["efforts"].map((effort: unknown) => ({ effort })),
				};
			}),
		});
		return { client_version: data["client_version"], fetchedAt: data["fetchedAt"], models };
	} catch {
		return undefined;
	}
}

export async function discoverCodex(
	dir: string,
	force = false,
	deps: DiscoveryDeps = defaults,
): Promise<Snapshot | undefined> {
	const file = path.join(dir, "codex-models.json");
	const previous = await cached(file);
	try {
		const version = (await deps.command(["--version"])).trim().replace(/^codex-cli\s+/u, "");
		if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new TypeError("invalid Codex version");
		if (
			!force &&
			previous?.client_version === version &&
			deps.now() - previous.fetchedAt < 3_600_000 &&
			deps.now() >= previous.fetchedAt
		)
			return previous;
		let models: Model[];
		try {
			models = parseModels(JSON.parse(await deps.command(["debug", "models"])));
		} catch {
			return previous?.client_version === version ? previous : undefined;
		}
		const snapshot = { client_version: version, fetchedAt: deps.now(), models };
		await locked(dir, async () => {
			const temp = path.join(dir, `.codex-${crypto.randomUUID()}`);
			await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
			await rename(temp, file);
		});
		return snapshot;
	} catch {
		// Never reuse another client's catalog after a downgrade or failed version check.
		return undefined;
	}
}

export function withCodexCatalog(catalog: Catalog, snapshot: Snapshot | undefined): Catalog {
	if (!snapshot) return { ...catalog, models: catalog.models.filter((m) => !HIDDEN.has(m.id)) };
	const known = new Map(catalog.models.filter((m) => m.provider === "codex").map((m) => [m.id, m]));
	const models = snapshot.models.map((m): CatalogModel => {
		const prior = known.get(m.slug);
		const family = m.slug.split("-").at(-1);
		const donors = [...known.values()].filter(
			(d) => d.id.split("-").at(-1) === family && d.score > 0,
		);
		const score = donors.length ? Math.min(...donors.map((d) => d.score)) * 0.9 : 35;
		return {
			...(prior ?? { id: m.slug, provider: "codex", score, unproven: true }),
			efforts: m.efforts,
		};
	});
	return {
		...catalog,
		models: [...catalog.models.filter((m) => m.provider !== "codex"), ...models],
	};
}

export interface Release {
	version: string;
	publishedAt: number;
}
export interface AlertDeps {
	notify: (message: string) => Promise<void>;
	release: () => Promise<Release>;
	now: () => number;
}
export const alertDefaults: AlertDeps = {
	notify: async (message) => {
		await exec(
			"ssh",
			[
				"-o",
				"BatchMode=yes",
				"-o",
				"ConnectTimeout=10",
				"dot14",
				"/home/docker/.claude/bin/shawn-send",
				"info",
				"codex-current",
				`'${message.replaceAll("'", "'\\''")}'`,
			],
			{ timeout: 30_000 },
		);
	},
	release: async () => {
		const response = await fetch("https://api.github.com/repos/openai/codex/releases/latest", {
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error("Codex release lookup failed");
		const data = object(await response.json());
		if (typeof data["tag_name"] !== "string" || typeof data["published_at"] !== "string")
			throw new TypeError("invalid Codex release");
		const version = data["tag_name"].replace(/^rust-v/u, "");
		const publishedAt = Date.parse(data["published_at"]);
		if (!/^\d+\.\d+\.\d+$/u.test(version) || !Number.isFinite(publishedAt))
			throw new TypeError("invalid Codex release version/date");
		return { version, publishedAt };
	},
	now: Date.now,
};

export async function checkCodexAlerts(
	dir: string,
	snapshot: Snapshot,
	catalog: Catalog,
	deps: AlertDeps = alertDefaults,
): Promise<void> {
	const release = await deps.release().catch(() => undefined);
	const known = new Set(catalog.models.filter((m) => m.provider === "codex").map((m) => m.id));
	const events = snapshot.models
		.filter((m) => !known.has(m.slug))
		.map((m) => ({
			key: `model:${m.slug}`,
			message: `New Codex model ${m.slug} available on client ${snapshot.client_version}; discovered and added to the router.`,
		}));
	if (
		release &&
		compareVersions(snapshot.client_version, release.version) < 0 &&
		deps.now() - release.publishedAt > 3 * 86_400_000
	)
		events.push({
			key: `release:${release.version}`,
			message: `Codex ${snapshot.client_version} lags ${release.version}, released ${new Date(release.publishedAt).toISOString().slice(0, 10)}. Check codex-update.service.`,
		});
	await locked(dir, async () => {
		const file = path.join(dir, "codex-alerts.json");
		let sent: string[] = [];
		try {
			const raw: unknown = JSON.parse(await readFile(file, "utf8"));
			if (!Array.isArray(raw) || !raw.every((v: unknown) => typeof v === "string"))
				throw new TypeError("invalid Codex alerts state");
			sent = raw;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		for (const event of events.filter((e) => !sent.includes(e.key))) {
			await deps.notify(event.message);
			sent.push(event.key);
			const temp = path.join(dir, `.alerts-${crypto.randomUUID()}`);
			await writeFile(temp, JSON.stringify(sent), { mode: 0o600 });
			await rename(temp, file);
		}
	});
}

function compareVersions(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const difference = left[i]! - right[i]!;
		if (difference) return difference;
	}
	return 0;
}
