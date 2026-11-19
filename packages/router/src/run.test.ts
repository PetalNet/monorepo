import { mkdtemp, readFile, writeFile, mkdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { classify, execute, launch, redact, resetTime } from "./adapters.ts";
import { POOLS, offersFrom, pick, type State, type Catalog } from "./pick.ts";
import { run } from "./run.ts";
import { markUnavailable, readAvailability, seedLedger } from "./state.ts";

vi.mock("@petalnet/harness-hooks/context-bundle", () => ({
	prepareDelegation: (prompt: string) => ({
		kind: "ready",
		prompt,
		sourceScope: prompt.startsWith("private:") ? "private" : "public-only",
	}),
}));

const dirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
	dirs.length = 0;
});

const catalog: Catalog = {
	tiers: { C: 0 },
	models: [
		{ id: "gemini-first-high", provider: "gemini", score: 40 },
		{ id: "gemini-second-low", provider: "gemini", score: 39 },
		{ id: "gpt-test", provider: "codex", score: 38 },
	],
};
const state: State = {
	nowMs: Date.now(),
	dataClass: "public",
	reports: {},
	exhausted: {},
	deny: [],
	denyPatterns: [],
	pools: POOLS.map(({ service: _service, ...pool }) => pool),
	blocks: [],
	floorPct: 15,
};

async function fixture() {
	const dir = await mkdtemp(path.join(tmpdir(), "router-run-"));

	dirs.push(dir);
	const injectPath = path.join(dir, "inject");

	await writeFile(
		injectPath,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> '${dir}/injections'\ncat >> '${dir}/injections'\n`,
		{ mode: 0o700 },
	);

	return {
		catalog,
		state,
		kind: "sweep",
		tier: "C",
		brief: "Reply with exactly: ok",
		cwd: dir,
		dir,
		legacy: path.join(dir, "legacy"),
		injectPath,
	};
}

async function events(dir: string) {
	return (await readFile(path.join(dir, "ledger.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => {
			const value: unknown = JSON.parse(line);

			if (!value || typeof value !== "object") {
				throw new Error("invalid event");
			}

			return Object.fromEntries(Object.entries(value)) as Record<string, unknown>;
		});
}

it("keeps private bundles away from pools that train on data", async () => {
	const options = await fixture();
	const attempts: string[] = [];
	const result = await run({
		...options,
		brief: "private: synthetic project",
		launch: (offer) => {
			attempts.push(offer.id);

			return { code: 0, out: "ok", log: "" };
		},
	});

	expect(result.code).toBe(0);
	expect(attempts).toEqual(["gpt-test"]);
});

it.each([
	["429 RESOURCE_EXHAUSTED Resets in 2h 3m", "quota", ["gemini-first-high", "gpt-test"]],
	["400 model not supported", "bad-offer", ["gemini-first-high", "gemini-second-low"]],
	["401 authentication failed", "auth", ["gemini-first-high", "gpt-test"]],
] as const)("falls through %s and persists availability", async (message, failure, expected) => {
	const options = await fixture();
	const attempts: string[] = [];
	const result = await run({
		...options,
		launch: (offer) => {
			attempts.push(offer.id);

			return attempts.length === 1
				? { code: 1, out: "", log: `AGY_ERROR: ${message}` }
				: { code: 0, out: "ok", log: "" };
		},
	});

	expect(result.code).toBe(0);
	expect(attempts).toEqual(expected);
	const rows = await events(options.dir);

	expect(rows.filter((r) => r["event"] === "launch")).toHaveLength(2);
	expect(rows.find((r) => r["event"] === "outcome")?.["failureClass"]).toBe(failure);
	expect(rows.filter((r) => r["event"] === "inject")).toHaveLength(1);
	const persisted = await readAvailability(options.dir);

	expect(
		pick(catalog, "sweep", "C", { ...state, availability: persisted }).ranked[0]?.offer.id,
	).toBe(expected[1]);

	expect((await stat(path.join(options.dir, "ledger.jsonl"))).mode & 0o777).toBe(0o600);
});

it("retries a transient exactly once after 30 seconds then falls through", async () => {
	const options = await fixture();
	const sleeps: number[] = [];
	const attempts: string[] = [];
	const result = await run({
		...options,
		sleep: (ms) => {
			sleeps.push(ms);
		},
		launch: (offer) => {
			attempts.push(offer.id);

			return {
				code: attempts.length < 3 ? 1 : 0,
				out: attempts.length < 3 ? "" : "ok",
				log: attempts.length < 3 ? "ERROR: 503 interrupted" : "",
			};
		},
	});

	expect(result.code).toBe(0);
	expect(sleeps).toEqual([30000]);
	expect(attempts).toEqual(["gemini-first-high", "gemini-first-high", "gemini-second-low"]);
});

it("skips sibling efforts after exhausting a model's transient retry", async () => {
	const options = await fixture();
	const attempts: string[] = [];
	const sleeps: number[] = [];
	const result = await run({
		...options,
		catalog: {
			tiers: { C: 0 },
			models: [
				{ id: "gemini-4-neon-xhigh", provider: "gemini", score: 40 },
				{ id: "gpt-test", provider: "codex", score: 38 },
			],
		},
		sleep: (ms) => sleeps.push(ms),
		launch: (offer) => {
			attempts.push(offer.id);

			return offer.provider === "gemini"
				? { code: 1, out: "", log: "AGY_ERROR: 503 unavailable" }
				: { code: 0, out: "ok", log: "" };
		},
	});

	expect(result.code).toBe(0);
	expect(attempts).toEqual(["gemini-4-neon-low", "gemini-4-neon-low", "gpt-test"]);
	expect(sleeps).toEqual([30000]);
	expect((await readAvailability(options.dir)).badOffers).toEqual({});
});

it("keeps bad-offer failures scoped to an agy effort variant", async () => {
	const options = await fixture();
	const attempts: string[] = [];
	const result = await run({
		...options,
		catalog: {
			tiers: { C: 0 },
			models: [{ id: "gemini-4-neon-xhigh", provider: "gemini", score: 40 }],
		},
		launch: (offer) => {
			attempts.push(offer.id);

			return attempts.length === 1
				? { code: 1, out: "", log: "AGY_ERROR: model_not_found" }
				: { code: 0, out: "ok", log: "" };
		},
	});

	expect(result.code).toBe(0);
	expect(attempts).toEqual(["gemini-4-neon-low", "gemini-4-neon-medium"]);

	expect(Object.keys((await readAvailability(options.dir)).badOffers)).toEqual([
		"google-ai:gemini-4-neon-low",
	]);
});

it.each(["", "What would you like to work on?"])(
	"stops empty/sentinel output without retry",
	async (out) => {
		const options = await fixture();
		let count = 0;
		const result = await run({
			...options,
			launch: () => {
				count++;

				return { code: 0, out, log: "" };
			},
		});

		expect(result.code).toBe(1);
		expect(count).toBe(1);
	},
);

it("redacts complete output before taking the injection tail", async () => {
	const options = await fixture();
	const secret = `sk-${"x".repeat(40)}`;

	await run({
		...options,
		launch: () => ({
			code: 0,
			out: `ok api_key=example-secret ${secret}\n-----BEGIN PRIVATE KEY-----\n${"x".repeat(5000)}\n-----END PRIVATE KEY-----`,
			log: `Authorization: Bearer ${secret}`,
		}),
	});

	const injection = await readFile(path.join(options.dir, "injections"), "utf8");

	expect(injection).not.toContain(secret);
	expect(injection).not.toContain("example-secret");
	expect(injection).not.toContain("x".repeat(30));
	expect(injection.match(/--source route --key/gu)).toHaveLength(1);
});

it("seeds legacy metadata only, once, even with concurrent runs", async () => {
	const options = await fixture();

	await mkdir(options.legacy);

	await writeFile(
		path.join(options.legacy, "old.log"),
		"started 2026-11-19T00:00:00Z model=gemini-test workdir=/private\nsecret=do-not-import\nended 2026-11-19T00:01:00Z rc=0\n",
	);

	await Promise.all([
		seedLedger(options.dir, options.legacy),
		seedLedger(options.dir, options.legacy),
	]);

	const rows = await events(options.dir);

	expect(rows.filter((r) => r["event"] === "import")).toHaveLength(1);
	expect(JSON.stringify(rows)).not.toContain("do-not-import");
	expect(rows[0]?.["kind"]).toBeNull();

	await Promise.all([
		markUnavailable(options.dir, "cooldowns", "a", 10),
		markUnavailable(options.dir, "cooldowns", "b", 20),
	]);

	expect((await readAvailability(options.dir)).cooldowns).toEqual({ a: 10, b: 20 });
});

it("allows overflow at zero quota but still honors a real cooldown", () => {
	const reports: State["reports"] = {
		codex: {
			service: "codex",
			status: "ok",
			summary: "",
			limits: [{ id: "codex:5h", label: "", usedPct: 100 }],
		},
	};
	const current = { ...state, pools: POOLS, reports };

	expect(pick(catalog, "sweep", "C", current).ranked[0]?.offer.id).toBe("gpt-test");

	expect(
		pick(catalog, "sweep", "C", {
			...current,
			availability: { cooldowns: { codex: Date.now() + 60000 }, badOffers: {}, signedOut: {} },
		}).ranked,
	).toHaveLength(0);
});

it("parses reset durations and absolute timestamps", () => {
	expect(resetTime("Resets in 2h 3m 4s", 0)).toBe(7384000);
	expect(resetTime("reset_at: 2026-11-20T10:00:00Z", 0)).toBe(Date.parse("2026-11-20T10:00:00Z"));
	expect(classify({ code: 1, out: "", log: "AGY_ERROR: model_not_found" })).toBe("bad-offer");
	expect(redact('"api_key": "secret-value"')).not.toContain("secret-value");
});

it("passes agy slug in argv and codex brief on stdin through fake executable adapters", async () => {
	const options = await fixture();
	const originalPath = process.env["PATH"];

	for (const name of ["agy", "codex"]) {
		// oxlint-disable-next-line no-await-in-loop -- Create executables before changing PATH.
		await writeFile(path.join(options.dir, name), '#!/bin/sh\nprintf "%s\\n" "$@"\ncat\n', {
			mode: 0o700,
		});
	}

	process.env["PATH"] = `${options.dir}:${originalPath ?? ""}`;

	try {
		const offers = offersFrom(catalog, "sweep", state.pools);

		for (const offer of offers) {
			// oxlint-disable-next-line no-await-in-loop -- Exercise adapters under the temporary PATH.
			const result = await launch(offer, "brief with $() and 'quotes'", options.cwd);

			expect(result.code).toBe(0);
			expect(result.out).toContain("brief with $() and 'quotes'");

			expect(result.out).toContain(
				offer.provider === "codex"
					? "--dangerously-bypass-approvals-and-sandbox"
					: "--dangerously-skip-permissions",
			);

			if (offer.provider === "gemini") {
				expect(result.out).toContain(offer.id);
			}
		}
	} finally {
		process.env["PATH"] = originalPath;
	}
});

it("does not classify successful prose about failures as failed execution", () => {
	for (const out of [
		"HTTP authentication uses a 401 status.",
		"The server returns 429 when over quota.",
		"There are 500 records.",
	]) {
		expect(classify({ code: 0, out, log: "" })).toBeNull();
	}

	expect(redact('password="two word secret"')).not.toContain("word secret");
});

it("hands Claude off without launching an adapter", async () => {
	const options = await fixture();
	const result = await run({
		...options,
		catalog: { tiers: { C: 0 }, models: [{ id: "opus", provider: "claude", score: 30 }] },
		state: { ...state, pools: state.pools.map(({ explicitOnly: _explicit, ...pool }) => pool) },
		launch: () => {
			throw new Error("Claude must not launch");
		},
	});

	expect(result.code).toBe(5);

	expect(await readFile(result.outputPath, "utf8")).toContain(
		"Claude handoff: model=opus effort=low",
	);
});

it("filters unsupported adapters before choosing a tier", () => {
	const result = pick(
		{
			tiers: { B: 30, C: 0 },
			models: [
				{ id: "local-test", provider: "local", score: 20 },
				{ id: "gpt-test", provider: "codex", score: 35 },
			],
		},
		"sweep",
		"C",
		{ ...state, runnableOnly: true },
	);

	expect(result.tier).toBe("B");
	expect(result.ranked[0]?.offer.provider).toBe("codex");
});

it("fails before launch on missing workdir or empty brief", async () => {
	const options = await fixture();

	await expect(run({ ...options, brief: "   " })).rejects.toThrow("invalid brief");
	await expect(run({ ...options, cwd: path.join(options.dir, "absent") })).rejects.toThrow();
});

it("never returns to an exhausted pool even after its reset expires during fallback", async () => {
	const options = await fixture();
	let now = Date.now();

	vi.spyOn(Date, "now").mockImplementation(() => now);
	const attempts: string[] = [];
	const result = await run({
		...options,
		launch: (offer) => {
			attempts.push(offer.id);

			if (attempts.length === 1) {
				return { code: 1, out: "", log: "AGY_ERROR: 429 Resets in 1s" };
			}

			now += 2000;

			return { code: 1, out: "", log: "AGY_ERROR: model_not_found" };
		},
	});

	expect(result.code).toBe(1);
	expect(attempts).toEqual(["gemini-first-high", "gpt-test"]);
	const saved = await readAvailability(options.dir);

	expect(saved.badOffers["codex:gpt-test"]).toBe(now + 86400000);
	expect(saved.cooldowns["google-ai:gemini"]).toBeLessThan(now);
});

it("does not cool down a pool because a failed builder transcript mentions rate limits", async () => {
	const options = await fixture();
	const adapter = path.join(options.dir, "adapter");

	await writeFile(
		adapter,
		`#!/bin/sh
printf '%s\\n' 'ERROR: 429 rate limit; Resets in 99h'
printf '%s\\n' 'builder: saw 429 RESOURCE_EXHAUSTED rate limit' 'quoted ERROR: authentication failed' '500 records' >&2
exit 1
`,
		{ mode: 0o700 },
	);

	const result = await run({
		...options,
		launch: () => execute(adapter, [], "", options.cwd),
	});

	expect(result.code).toBe(1);

	expect(await readAvailability(options.dir)).toEqual({
		cooldowns: {},
		badOffers: {},
		signedOut: {},
	});

	const rows = await events(options.dir);

	expect(rows.filter((row) => row["event"] === "launch")).toHaveLength(1);
	expect(rows.find((row) => row["event"] === "outcome")?.["failureClass"]).toBe("unknown");
});

it("uses only adapter error lines for cooldown timestamps", async () => {
	const options = await fixture();
	const now = Date.now();

	vi.spyOn(Date, "now").mockReturnValue(now);

	await run({
		...options,
		launch: () => ({
			code: 1,
			out: "Resets in 99h",
			log: "Resets in 99h\nAGY_ERROR: 429 Resets in 1s",
		}),
	});

	expect((await readAvailability(options.dir)).cooldowns["google-ai:gemini"]).toBe(now + 1000);
});

it.each([
	["429 RESOURCE_EXHAUSTED", "quota"],
	["usage limit reached", "quota"],
	["rate limit reached", "quota"],
	["quota exceeded", "quota"],
	["model_not_found", "bad-offer"],
	["401 authentication failed", "auth"],
	["503 interrupted", "transient"],
] as const)("classifies %s only on adapter error lines", (message, expected) => {
	for (const prefix of ["AGY_ERROR:", "ERROR:"]) {
		expect(classify({ code: 1, out: "", log: `${prefix} ${message}` })).toBe(expected);
		expect(classify({ code: 1, out: `${prefix} ${message}`, log: "" })).toBe("unknown");
		expect(classify({ code: 1, out: "", log: `builder: ${prefix} ${message}` })).toBe("unknown");
		expect(classify({ code: 0, out: "ok", log: `${prefix} ${message}` })).toBeNull();
	}
});
