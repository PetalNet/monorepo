import { execFile } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

import type { ServiceReport, SourceConfig, SourceDeps } from "./quota-sources.ts";
import {
	parseAgyQuota,
	parseClaudeUsageJson,
	parseClaudeUsageText,
	parseCloudflareNeurons,
	parseCodexLoginStatus,
	parseCodexRateLimits,
	parseGitHubActionsUsage,
	parseResetTimestamp,
	parseTMobileBudget,
	readCloudflareAi,
	readCodex,
	readGitHubActions,
	sourceConfigFromEnv,
} from "./quota-sources.ts";
import type { WatchConfig, WatchDeps, WatchState } from "./quota-watch.ts";
import {
	DEFAULT_THRESHOLDS,
	formatReport,
	highestCrossedThreshold,
	isSameWindow,
	loadState,
	runCheck,
	saveState,
} from "./quota-watch.ts";

const NOW = Date.parse("2026-11-19T20:15:00Z");
const TZ = "America/Chicago";
const QUOTA_CLI = path.join(import.meta.dirname, "quota.ts");
const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "quota-test-"));

	tempDirs.push(dir);

	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("quota source parsers", () => {
	it("parses Claude usage JSON with 7d and Fable limits", () => {
		const payload = JSON.stringify({
			five_hour_pct: 0,
			five_hour_resets_at: 0,
			five_hour_resets_at_iso: null,
			seven_day_pct: 63,
			seven_day_resets_at_iso: "2026-11-24T10:00:00.675071+00:00",
			scraped_at: Math.floor(NOW / 1_000) - 60,
			raw: {
				limits: [
					{
						kind: "weekly_all",
						percent: 63,
						resets_at: "2026-11-24T10:00:00.675071+00:00",
					},
					{
						kind: "weekly_scoped",
						percent: 6,
						resets_at: "2026-11-24T09:59:59.675194+00:00",
						scope: { model: { display_name: "Fable" } },
					},
				],
			},
		});
		const report = parseClaudeUsageJson(payload, NOW, TZ);

		expect(report.status).toBe("ok");
		expect(report.summary).toContain("5h idle · 7d 63% · Fable 6%");
		expect(report.limits).toHaveLength(2);
		expect(report.limits[0]?.id).toBe("claude:7d");
		expect(report.limits[0]?.usedPct).toBe(63);
		expect(report.limits[0]?.windowId).toBe("2026-11-24T10:00Z");
		expect(report.limits[1]?.id).toBe("claude:fable");
		expect(report.limits[1]?.usedPct).toBe(6);
		expect(report.limits[1]?.windowId).toBe("2026-11-24T10:00Z");
	});

	it("parses Claude plain-text fallback output", () => {
		const report = parseClaudeUsageText("🟢 5h idle · 7d 89% · Fable 98%", NOW);

		expect(report.status).toBe("ok");

		expect(report.limits.map((l) => [l.id, l.usedPct])).toEqual([
			["claude:7d", 89],
			["claude:fable", 98],
		]);
	});

	it("parses agy -p /quota in both non-TTY TSV and TTY aligned formats", () => {
		const tsv = [
			"Gemini Models\tWeekly Limit Remaining\t87%\t2026-11-25T21:20:29Z",
			"Gemini Models\tFive Hour Limit Remaining\t64%\t2026-11-19T23:34:51Z",
			"Claude and GPT models\tWeekly Limit Remaining\t5%\t2026-11-26T07:01:27Z",
			"Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-11-19T23:35:28Z",
			"Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t77%\t2026-11-25T18:58:44Z",
		].join("\n");
		const fromTsv = parseAgyQuota(tsv, NOW, TZ);

		expect(fromTsv.status).toBe("ok");

		expect(fromTsv.limits.map((l) => [l.id, l.usedPct])).toEqual([
			["google-ai:gemini-models:7d", 13],
			["google-ai:gemini-models:5h", 36],
			["google-ai:claude-and-gpt-models:7d", 95],
			["google-ai:claude-and-gpt-models:5h", 100],
			["google-ai:gemini-4-argon:7d", 23],
		]);

		expect(fromTsv.limits[0]?.resetAtMs).toBe(Date.parse("2026-11-25T21:20:29Z"));

		const tty = [
			"Quota:",
			"Gemini Models          Weekly Limit Remaining       94%  2026-11-25 15:20 CST",
			"Claude and GPT models  Five Hour Limit Remaining    0%   2026-11-19 17:35 CST",
		].join("\n");
		const fromTty = parseAgyQuota(tty, NOW, TZ);

		expect(fromTty.status).toBe("ok");

		expect(fromTty.limits.map((l) => [l.id, l.usedPct])).toEqual([
			["google-ai:gemini-models:7d", 6],
			["google-ai:claude-and-gpt-models:5h", 100],
		]);

		expect(fromTty.limits[0]?.resetAtMs).toBe(Date.parse("2026-11-25T21:20:00Z"));
	});

	it("parses reset timestamps in both CST and UTC ISO formats", () => {
		expect(parseResetTimestamp("2026-11-25 15:20 CST")).toBe(Date.parse("2026-11-25T21:20:00Z"));
		expect(parseResetTimestamp("2026-11-25T21:20:29Z")).toBe(Date.parse("2026-11-25T21:20:29Z"));
		expect(parseResetTimestamp("N/A")).toBeUndefined();
	});

	it("interprets Codex login status and session rate limits", () => {
		expect(parseCodexLoginStatus(1, "Not logged in\n", "").signedIn).toBe(false);
		expect(parseCodexLoginStatus(0, "Logged in using ChatGPT\n", "").signedIn).toBe(true);

		const report = parseCodexRateLimits(
			{
				primary: { used_percent: 42, resets_at: Math.floor(NOW / 1_000) + 3_600 },
				secondary: { used_percent: 91, resets_at: Math.floor(NOW / 1_000) + 86_400 },
			},
			NOW,
			TZ,
		);

		expect(report.status).toBe("ok");

		expect(report.limits.map((l) => [l.id, l.usedPct])).toEqual([
			["codex:5h", 42],
			["codex:7d", 91],
		]);
	});

	it("parses Cloudflare Workers AI neurons and 4006 cap hits", () => {
		const raw = {
			data: {
				viewer: {
					accounts: [
						{
							aiInferenceAdaptiveGroups: [
								{
									count: 347,
									dimensions: { errorCode: 0, modelId: "@cf/cloudflare/clef" },
									sum: { totalNeurons: 32_115.85 },
								},
								{
									count: 30,
									dimensions: { errorCode: 4006, modelId: "@cf/cloudflare/clef" },
									sum: { totalNeurons: 0 },
								},
								{
									count: 378,
									dimensions: { errorCode: 0, modelId: "@cf/cloudflare/clef-flash" },
									sum: { totalNeurons: 5_953.49 },
								},
							],
						},
					],
				},
			},
			errors: null,
		};
		const report = parseCloudflareNeurons(raw, "2026-11-19", 10_000);

		expect(report.status).toBe("ok");
		expect(report.summary).toContain("38,069/10,000 neurons (380.7%)");
		expect(report.summary).toContain("30 cap hits (4006)");
		expect(report.limits[0]?.id).toBe("cloudflare-ai:daily");
		expect(report.limits[0]?.usedPct).toBe(380.7);
		expect(report.limits[0]?.windowId).toBe("2026-11-19");
	});

	it("parses GitHub Actions private-repo minutes with OS multipliers and excludes public repos", () => {
		const raw = {
			usageItems: [
				{
					product: "actions",
					sku: "Actions Linux",
					quantity: 74_634,
					unitType: "Minutes",
					repositoryName: "monorepo",
				},
				{
					product: "actions",
					sku: "Actions Linux",
					quantity: 177,
					unitType: "Minutes",
					repositoryName: "hermes-cc-link",
				},
				{
					product: "actions",
					sku: "Actions Windows",
					quantity: 50,
					unitType: "Minutes",
					repositoryName: "private-win",
				},
				{
					product: "actions",
					sku: "Actions storage",
					quantity: 35,
					unitType: "GigabyteHours",
					repositoryName: "hermes-cc-link",
				},
			],
		};
		const report = parseGitHubActionsUsage(raw, new Set(["monorepo"]), 2026, 11, 2_000, "PetalNet");

		expect(report.status).toBe("ok");
		// 177 * 1 + 50 * 2 = 277 private minutes => 13.9% of 2,000
		expect(report.limits[0]?.usedPct).toBe(13.9);
		expect(report.limits[0]?.windowId).toBe("2026-11");
		expect(report.summary).toContain("277/2,000 private min");
		expect(report.summary).toContain("public 74,634 min");
	});

	it("parses T-Mobile data budget cycle and priority week", () => {
		const raw = {
			cycle: "2026-11-13",
			last: {
				t: "2026-11-19T14:15:01-06:00",
				total_gb: 496.05,
				pct: 41.34,
				budget_gb: 1200,
				cycle_start: "2026-11-13T00:00:00-06:00",
				cycle_end: "2026-12-13T00:00:00-06:00",
				week_start: "2026-11-16T00:00:00-06:00",
				priority_week_gb: 271.14,
				priority_week_budget_gb: 200,
				priority_week_pct: 135.57,
			},
		};
		const report = parseTMobileBudget(raw, NOW, TZ);

		expect(report.status).toBe("ok");

		expect(report.limits.map((l) => [l.id, l.usedPct, l.windowId])).toEqual([
			["tmobile:cycle", 41.3, "cycle:2026-11-13"],
			["tmobile:priority-week", 135.6, "week:2026-11-16"],
		]);

		expect(report.summary).toContain("496.1/1,200 GB (41.3%");
		expect(report.summary).toContain("priority wk 271.1/200 GB (135.6%)");
	});
});

describe("token safety and reader behavior", () => {
	const baseConfig: SourceConfig = sourceConfigFromEnv({ HOME: "/nonexistent" });

	it("reads Cloudflare token once from vault and never exposes it on error", async () => {
		const secret = "cf-super-secret-token-value-12345";
		let vaultCalls = 0;
		const deps: SourceDeps = {
			now: () => NOW,
			exec: (cmd, args) => {
				expect(cmd).toBe("vault");
				expect(args).toEqual(["get", "cf-janet-full-token"]);
				vaultCalls += 1;

				return Promise.resolve({ code: 0, stdout: `${secret}\n`, stderr: "" });
			},
			http: (_url, init) => {
				expect(init.headers?.["Authorization"]).toBe(`Bearer ${secret}`);

				return Promise.resolve({ status: 500, ok: false, text: "internal error" });
			},
			readFile: () => "",
		};

		const report = await readCloudflareAi(baseConfig, deps);

		expect(vaultCalls).toBe(1);
		expect(report.status).toBe("error");
		expect(JSON.stringify(report)).not.toContain(secret);
	});

	it("reads GitHub PAT once and never exposes it in output", async () => {
		const secret = "ghp_superSecretPat987654321";
		let readCalls = 0;
		const deps: SourceDeps = {
			now: () => NOW,
			exec: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
			http: (url, init) => {
				expect(init.headers?.["Authorization"]).toBe(`Bearer ${secret}`);

				if (url.includes("/repos?")) {
					return Promise.resolve({
						status: 200,
						ok: true,
						text: JSON.stringify([{ name: "monorepo" }]),
					});
				}

				if (url.includes("/billing/usage")) {
					return Promise.resolve({ status: 403, ok: false, text: "forbidden" });
				}

				return Promise.resolve({
					status: 200,
					ok: true,
					text: JSON.stringify({ plan: { name: "free" } }),
				});
			},
			readFile: () => {
				readCalls += 1;

				return `${secret}\n`;
			},
		};

		const report = await readGitHubActions(baseConfig, deps);

		expect(readCalls).toBe(1);
		expect(report.status).toBe("error");
		expect(JSON.stringify(report)).not.toContain(secret);
	});

	it("reports Codex as signed-out without reading session files", async () => {
		let readCalled = false;
		const deps: SourceDeps = {
			now: () => NOW,
			exec: () => Promise.resolve({ code: 1, stdout: "Not logged in\n", stderr: "" }),
			http: () => Promise.resolve({ status: 200, ok: true, text: "" }),
			readFile: () => {
				readCalled = true;

				return "";
			},
		};

		const report = await readCodex(baseConfig, deps);

		expect(report.status).toBe("signed-out");
		expect(report.summary).toBe("signed out");
		expect(report.limits).toEqual([]);
		expect(readCalled).toBe(false);
	});
});

describe("threshold watcher and state deduplication", () => {
	function makeWatchEnv(
		reports: () => ServiceReport[],
		injectOk = true,
	): {
		config: WatchConfig;
		deps: WatchDeps;
		injections: { prompt: string; source: string; key: string }[];
		getState: () => WatchState;
	} {
		let state: WatchState = { version: 1, limits: {} };
		let exists = false;
		const injections: { prompt: string; source: string; key: string }[] = [];
		const config: WatchConfig = {
			stateFile: "/tmp/virtual-state.json",
			injectCommand: "/bin/false",
			thresholds: [...DEFAULT_THRESHOLDS],
			source: sourceConfigFromEnv({ HOME: "/nonexistent" }),
		};
		const deps: WatchDeps = {
			now: () => NOW,
			readServices: () => Promise.resolve(reports()),
			inject: (prompt, source, key) => {
				injections.push({ prompt, source, key });

				return { ok: injectOk, output: injectOk ? "queued 1" : "hub down" };
			},
			stateExists: () => exists,
			loadState: () => state,
			saveState: (_path, next) => {
				state = next;
				exists = true;
			},
		};

		return { config, deps, injections, getState: () => state };
	}

	it("selects highest crossed threshold and tolerates reset timestamp jitter", () => {
		expect(highestCrossedThreshold(87.9, [88, 98])).toBeUndefined();
		expect(highestCrossedThreshold(88, [88, 98])).toBe(88);
		expect(highestCrossedThreshold(97.9, [88, 98])).toBe(88);
		expect(highestCrossedThreshold(98, [88, 98])).toBe(98);
		expect(highestCrossedThreshold(380.7, [88, 98])).toBe(98);

		const recorded = {
			windowId: "2026-11-24T10:00Z",
			resetAtMs: Date.parse("2026-11-24T10:00:00Z"),
			alertedThreshold: 88,
			alertedAt: "2026-11-19T20:00:00Z",
			alertedPct: 89,
		};

		// Two minutes of API clock jitter across a bucket boundary is still the same window.
		expect(
			isSameWindow(recorded, {
				id: "claude:7d",
				label: "Claude 7d",
				usedPct: 90,
				windowId: "2026-11-24T10:30Z",
				resetAtMs: Date.parse("2026-11-24T10:02:00Z"),
			}),
		).toBe(true);

		// A 7-day reset is a new window.
		expect(
			isSameWindow(recorded, {
				id: "claude:7d",
				label: "Claude 7d",
				usedPct: 90,
				windowId: "2026-12-01T10:00Z",
				resetAtMs: Date.parse("2026-12-01T10:00:00Z"),
			}),
		).toBe(false);
	});

	it("injects exactly once at 88%, once more at 98%, and again after a reset window rollover", async () => {
		let pct = 60;
		let resetAt = Date.parse("2026-11-24T10:00:00Z");
		let windowId = "2026-11-24T10:00Z";
		const env = makeWatchEnv(() => [
			{
				service: "claude",
				status: "ok",
				summary: `7d ${String(pct)}%`,
				limits: [
					{
						id: "claude:7d",
						label: "Claude 7d",
						usedPct: pct,
						windowId,
						resetAtMs: resetAt,
						resetLabel: "Nov 24 04:00",
					},
				],
			},
		]);

		// Below 88%: no injection.
		const r1 = await runCheck(env.config, env.deps);

		expect(r1.injected).toHaveLength(0);
		expect(env.injections).toHaveLength(0);

		// Crosses 88%: injects once.
		pct = 90;
		const r2 = await runCheck(env.config, env.deps);

		expect(r2.injected).toHaveLength(1);
		expect(r2.injected[0]?.threshold).toBe(88);
		expect(env.injections).toHaveLength(1);
		expect(env.injections[0]?.source).toBe("quota-watch");
		expect(env.injections[0]?.key).toBe("quota:claude:7d:88:2026-11-24T10:00Z");

		// Stays at 93% with 2-minute reset jitter: no duplicate injection.
		pct = 93;
		resetAt += 2 * 60_000;
		const r3 = await runCheck(env.config, env.deps);

		expect(r3.injected).toHaveLength(0);
		expect(env.injections).toHaveLength(1);

		// Crosses 98% in the same window: injects once at 98% tier.
		pct = 98.5;
		const r4 = await runCheck(env.config, env.deps);

		expect(r4.injected).toHaveLength(1);
		expect(r4.injected[0]?.threshold).toBe(98);
		expect(env.injections).toHaveLength(2);

		// Stays at 100%: no further injection in this window.
		pct = 100;
		const r5 = await runCheck(env.config, env.deps);

		expect(r5.injected).toHaveLength(0);
		expect(env.injections).toHaveLength(2);

		// Next reset window (+7 days): resets and fires once again when >= 88%.
		resetAt = Date.parse("2026-12-01T10:00:00Z");
		windowId = "2026-12-01T10:00Z";
		pct = 89;
		const r6 = await runCheck(env.config, env.deps);

		expect(r6.injected).toHaveLength(1);
		expect(r6.injected[0]?.threshold).toBe(88);
		expect(env.injections).toHaveLength(3);
	});

	it("injects only once at 98% when jumping straight from 0% to 99%", async () => {
		const env = makeWatchEnv(() => [
			{
				service: "cloudflare-ai",
				status: "ok",
				summary: "9,900/10,000 neurons (99%)",
				limits: [
					{
						id: "cloudflare-ai:daily",
						label: "Cloudflare Workers AI daily neurons",
						usedPct: 99,
						windowId: "2026-11-19",
					},
				],
			},
		]);

		const r1 = await runCheck(env.config, env.deps);
		const r2 = await runCheck(env.config, env.deps);

		expect(r1.injected).toHaveLength(1);
		expect(r1.injected[0]?.threshold).toBe(98);
		expect(r2.injected).toHaveLength(0);
		expect(env.injections).toHaveLength(1);
	});

	it("does not record state when cc-link-inject fails, so the next tick retries", async () => {
		let shouldSucceed = false;
		const env = makeWatchEnv(() => [
			{
				service: "tmobile",
				status: "ok",
				summary: "1,100/1,200 GB (91.7%)",
				limits: [
					{
						id: "tmobile:cycle",
						label: "T-Mobile cycle data",
						usedPct: 91.7,
						windowId: "cycle:2026-11-13",
					},
				],
			},
		]);

		env.deps.inject = (prompt, source, key) => {
			env.injections.push({ prompt, source, key });

			return { ok: shouldSucceed, output: shouldSucceed ? "queued" : "unreachable" };
		};

		const failed = await runCheck(env.config, env.deps);

		expect(failed.injected).toHaveLength(0);
		expect(failed.injectErrors).toHaveLength(1);
		expect(env.getState().limits["tmobile:cycle"]).toBeUndefined();

		shouldSucceed = true;
		const retried = await runCheck(env.config, env.deps);

		expect(retried.injected).toHaveLength(1);
		expect(retried.injectErrors).toHaveLength(0);
		expect(env.getState().limits["tmobile:cycle"]?.alertedThreshold).toBe(88);
	});

	it("persists state atomically on disk", () => {
		const dir = makeTempDir();
		const stateFile = path.join(dir, "nested", "state.json");

		expect(loadState(stateFile)).toEqual({ version: 1, limits: {} });

		saveState(stateFile, {
			version: 1,
			limits: {
				"claude:7d": {
					windowId: "2026-11-24T10:00Z",
					resetAtMs: Date.parse("2026-11-24T10:00:00Z"),
					alertedThreshold: 88,
					alertedAt: "2026-11-19T20:15:00.000Z",
					alertedPct: 89,
				},
			},
		});

		expect(existsSync(stateFile)).toBe(true);
		expect(loadState(stateFile).limits["claude:7d"]?.alertedThreshold).toBe(88);
	});

	it("formats one line per service", () => {
		const text = formatReport([
			{ service: "claude", status: "ok", summary: "5h idle · 7d 63%", limits: [] },
			{ service: "codex", status: "signed-out", summary: "signed out", limits: [] },
			{ service: "tmobile", status: "error", summary: "down", limits: [], error: "ssh failed" },
		]);

		expect(text.split("\n")).toHaveLength(3);
		expect(text).toContain("claude          5h idle · 7d 63%");
		expect(text).toContain("codex           signed out");
		expect(text).toContain("tmobile         error: ssh failed");
	});
});

describe("quota CLI end-to-end simulation", () => {
	it("prints six lines and fires a simulated threshold crossing exactly once", async () => {
		const dir = makeTempDir();
		const binDir = path.join(dir, "bin");
		const stateFile = path.join(dir, "state.json");
		const injectLog = path.join(dir, "injections.log");
		const tokenFile = path.join(dir, "github-pat");
		const tmobileFile = path.join(dir, "data-budget.json");

		mkdirSync(binDir, { recursive: true });
		writeFileSync(tokenFile, "ghp_test_token\n", "utf8");

		writeFileSync(
			tmobileFile,
			JSON.stringify({
				cycle: "2026-11-13",
				last: {
					t: new Date().toISOString(),
					total_gb: 496.05,
					pct: 41.34,
					budget_gb: 1200,
					cycle_end: "2026-12-13T00:00:00-06:00",
				},
			}),
			"utf8",
		);

		const writeScript = (name: string, body: string) => {
			const scriptPath = path.join(binDir, name);

			writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, "utf8");
			chmodSync(scriptPath, 0o755);

			return scriptPath;
		};

		const claudePctFile = path.join(dir, "claude-pct");
		const claudeResetFile = path.join(dir, "claude-reset");

		writeFileSync(claudePctFile, "90", "utf8");
		writeFileSync(claudeResetFile, "2026-11-24T10:00:00Z", "utf8");

		const claudeCmd = writeScript(
			"usage",
			`pct=$(cat "${claudePctFile}")
reset=$(cat "${claudeResetFile}")
printf '{"five_hour_pct":0,"five_hour_resets_at":0,"seven_day_pct":%s,"seven_day_resets_at_iso":"%s","scraped_at":%s,"raw":{"limits":[]}}\n' "$pct" "$reset" "$(date +%s)"`,
		);
		const agyCmd = writeScript(
			"agy",
			`printf 'Gemini Models\\tWeekly Limit Remaining\\t90%%\\t2026-11-25T21:20:00Z\\n'`,
		);
		const codexCmd = writeScript("codex", `echo "Not logged in"; exit 1`);
		const vaultCmd = writeScript("vault", `echo "cf_test_token"`);
		const injectCmd = writeScript(
			"cc-link-inject",
			`body=$(cat)
printf '%s | %s\\n' "$*" "$body" >> "${injectLog}"`,
		);

		const server = http.createServer((req, res) => {
			res.setHeader("Content-Type", "application/json");

			if (req.url === "/graphql") {
				res.end(
					JSON.stringify({
						data: {
							viewer: {
								accounts: [
									{
										aiInferenceAdaptiveGroups: [
											{
												count: 10,
												dimensions: { errorCode: 0, modelId: "@cf/test" },
												sum: { totalNeurons: 2_500 },
											},
										],
									},
								],
							},
						},
						errors: null,
					}),
				);

				return;
			}

			if (req.url?.includes("/repos?")) {
				res.end(JSON.stringify([{ name: "monorepo" }]));

				return;
			}

			if (req.url?.includes("/billing/usage")) {
				res.end(
					JSON.stringify({
						usageItems: [
							{
								product: "actions",
								sku: "Actions Linux",
								quantity: 200,
								unitType: "Minutes",
								repositoryName: "hermes-cc-link",
							},
						],
					}),
				);

				return;
			}

			res.end(JSON.stringify({ plan: { name: "free" } }));
		});

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				resolve();
			});
		});

		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const env: NodeJS.ProcessEnv = {
			...process.env,
			QUOTA_STATE_FILE: stateFile,
			QUOTA_INJECT: injectCmd,
			QUOTA_CLAUDE_USAGE_CMD: claudeCmd,
			QUOTA_AGY_CMD: agyCmd,
			QUOTA_CODEX_CMD: codexCmd,
			QUOTA_VAULT_CMD: vaultCmd,
			QUOTA_CF_GRAPHQL_URL: `http://127.0.0.1:${String(port)}/graphql`,
			QUOTA_GITHUB_TOKEN_FILE: tokenFile,
			QUOTA_GITHUB_API_URL: `http://127.0.0.1:${String(port)}`,
			QUOTA_TMOBILE_FILE: tmobileFile,
		};

		try {
			// 1. `quota` prints 6 lines, one per service.
			const { stdout: statusOut } = await execFileAsync(
				process.execPath,
				["--no-warnings", QUOTA_CLI],
				{ env, encoding: "utf8" },
			);

			expect(statusOut.trim().split("\n")).toHaveLength(6);
			expect(statusOut).toContain("claude          5h idle · 7d 90%");
			expect(statusOut).toContain("codex           signed out");

			// 2. First `quota check` at 90% injects exactly once, silent on stdout.
			const { stdout: check1 } = await execFileAsync(
				process.execPath,
				["--no-warnings", QUOTA_CLI, "check"],
				{ env, encoding: "utf8" },
			);

			expect(check1).toBe("");
			const linesAfter1 = readFileSync(injectLog, "utf8").trim().split("\n");

			expect(linesAfter1).toHaveLength(1);
			expect(linesAfter1[0]).toContain("--source quota-watch");
			expect(linesAfter1[0]).toContain("Claude 7d (claude) crossed 88% used");

			// 3. Second `quota check` in the same reset window does NOT inject again.
			await execFileAsync(process.execPath, ["--no-warnings", QUOTA_CLI, "check"], {
				env,
				encoding: "utf8",
			});

			const linesAfter2 = readFileSync(injectLog, "utf8").trim().split("\n");

			expect(linesAfter2).toHaveLength(1);

			// 4. Advance to next reset window: injects once for the new window.
			writeFileSync(claudeResetFile, "2026-12-01T10:00:00Z", "utf8");

			await execFileAsync(process.execPath, ["--no-warnings", QUOTA_CLI, "check"], {
				env,
				encoding: "utf8",
			});

			const linesAfter3 = readFileSync(injectLog, "utf8").trim().split("\n");

			expect(linesAfter3).toHaveLength(2);
		} finally {
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		}
	});
});
