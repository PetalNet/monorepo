import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import type { QuotaLimit, ServiceReport } from "@petalnet/harness-hooks/quota-sources";

import type { Pool } from "./pick.ts";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}

function eventRecord(line: string) {
	try {
		return record(JSON.parse(line));
	} catch {
		return undefined;
	}
}

function identifier(value: unknown) {
	return typeof value === "string" && /^[\w][\w.:-]{0,127}$/u.test(value) ? value : null;
}

function nonnegative(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function readProviderEvents(provider: "codex" | "agy", stdout: string) {
	let nativeSessionId: string | null = null;
	let respondingModel: string | null = null;
	let tokens: Record<string, unknown> | undefined;
	let reportedChargeUsd: number | null = null;
	let out = "";
	const errors: string[] = [];

	for (const line of stdout.split("\n")) {
		const event = eventRecord(line);

		if (provider === "agy") {
			const result = event?.["event"] === "result" ? record(event["result"]) : undefined;

			if (result) {
				nativeSessionId = identifier(result["conversation_id"]);
				respondingModel = identifier(result["model"]);
				out = typeof result["response"] === "string" ? result["response"] : "";
				tokens = record(result["usage"]);
				reportedChargeUsd = nonnegative(result["billed_cost_usd"]);
			}

			continue;
		}

		switch (event?.["type"]) {
			case "thread.started":
				nativeSessionId = identifier(event["thread_id"]);
				respondingModel = identifier(event["model"]);

				break;
			case "item.completed": {
				const item = record(event["item"]);

				if (item?.["type"] === "agent_message" && typeof item["text"] === "string") {
					out = item["text"];
				}

				break;
			}
			case "turn.completed":
				tokens = record(event["usage"]);

				break;
			case "turn.failed":
			case "error": {
				const message = record(event["error"])?.["message"] ?? event["message"];

				if (typeof message === "string") {
					errors.push(`ERROR: ${message.replace(/\s+/gu, " ")}`);
				}

				break;
			}
		}
	}

	return {
		out,
		errors: errors.join("\n"),
		telemetry: {
			nativeSessionId,
			respondingModel,
			usage: tokens
				? {
						source: provider,
						inputTokens: nonnegative(tokens["input_tokens"]),
						outputTokens: nonnegative(tokens["output_tokens"]),
						cachedInputTokens: nonnegative(
							tokens["cached_input_tokens"] ?? tokens["cache_read_tokens"],
						),
						cacheWriteInputTokens: nonnegative(tokens["cache_write_input_tokens"]),
						reasoningTokens: nonnegative(
							tokens["reasoning_output_tokens"] ?? tokens["thinking_tokens"],
						),
						totalTokens: nonnegative(tokens["total_tokens"]),
					}
				: null,
			cost: {
				charge:
					reportedChargeUsd === null
						? null
						: { usd: reportedChargeUsd, basis: "provider billed_cost_usd" },
				apiEquivalent: null,
				planOpportunity: null,
			},
		},
	};
}

export type ProviderTelemetry = ReturnType<typeof readProviderEvents>["telemetry"];

function codexQuota(value: unknown, format: "rpc" | "rollout"): ServiceReport | undefined {
	const quota = record(value);
	const limits: QuotaLimit[] = [];

	for (const key of ["primary", "secondary"]) {
		const window = record(quota?.[key]);
		const minutes = window?.[format === "rpc" ? "windowDurationMins" : "window_minutes"];
		const duration = minutes === 300 ? "5h" : minutes === 10080 ? "7d" : null;
		const usedPct = nonnegative(window?.[format === "rpc" ? "usedPercent" : "used_percent"]);
		const reset = nonnegative(window?.[format === "rpc" ? "resetsAt" : "resets_at"]);

		if (duration !== null && usedPct !== null) {
			const resetAtMs = reset === null ? undefined : reset * 1000;

			limits.push({ id: `codex:${duration}`, label: duration, usedPct, resetAtMs });
		}
	}

	return limits.length === 0 ? undefined : { service: "codex", status: "ok", summary: "", limits };
}

export function readCodexAccountQuota(command: string): Promise<ServiceReport | undefined> {
	return new Promise((resolve) => {
		const server = spawn(command, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
		const lines = createInterface({ input: server.stdout });
		const finish = (report?: ServiceReport) => {
			clearTimeout(timeout);
			lines.close();
			server.kill("SIGKILL");
			resolve(report);
		};

		const timeout = setTimeout(finish, 8000);
		const send = (message: object) => {
			server.stdin.write(`${JSON.stringify(message)}\n`);
		};

		server.once("error", () => {
			finish();
		});

		server.once("close", () => {
			finish();
		});

		server.stdin.once("error", () => {
			finish();
		});

		lines.on("line", (line) => {
			const response = eventRecord(line);
			const result = record(response?.["result"]);

			if (response?.["id"] === 1 && result) {
				send({ method: "initialized" });
				send({ method: "account/rateLimits/read", id: 2, params: {} });
			} else if (response?.["id"] === 1 || response?.["id"] === 2) {
				finish(codexQuota(result?.["rateLimits"], "rpc"));
			}
		});

		send({ method: "initialize", id: 1, params: { clientInfo: { name: "route", version: "0" } } });
	});
}

export async function readCodexSession(
	sessionsDir: string,
	id: string,
	startedAt: number,
	signal?: AbortSignal,
) {
	const days = [0, -86400000, 86400000].map((offset) => {
		const day = new Date(startedAt + offset).toISOString().slice(0, 10);

		return path.join(sessionsDir, ...day.split("-"));
	});
	const candidates = await Promise.all(
		days.map(async (day) => {
			const files = await readdir(day).catch(() => []);
			const name = files.find(
				(file) => file.startsWith("rollout-") && file.endsWith(`-${id}.jsonl`),
			);

			return name ? path.join(day, name) : undefined;
		}),
	);
	const file = candidates.find((candidate) => candidate !== undefined);
	let respondingModel: string | null = null;
	let quota: { at: number; report: ServiceReport } | null = null;

	if (!file) {
		return { respondingModel, quota };
	}

	const lines = createInterface({
		input: createReadStream(file, { encoding: "utf8", signal }),
		crlfDelay: Infinity,
	});

	for await (const line of lines) {
		const event = eventRecord(line);
		const payload = record(event?.["payload"]);

		if (event?.["type"] === "turn_context") {
			respondingModel = identifier(payload?.["model"]) ?? respondingModel;
		} else if (event?.["type"] === "event_msg" && payload?.["type"] === "model_reroute") {
			respondingModel = identifier(payload["to_model"]) ?? respondingModel;
		} else if (event?.["type"] === "event_msg" && payload?.["type"] === "token_count") {
			const raw = record(payload["rate_limits"]);
			const report =
				raw?.["limit_id"] === "codex" || raw?.["limit_id"] == null
					? codexQuota(raw, "rollout")
					: undefined;
			const at =
				typeof event["timestamp"] === "string" ? Date.parse(event["timestamp"]) : Number.NaN;

			if (report && Number.isFinite(at)) {
				quota = { at, report };
			}
		}
	}

	return { respondingModel, quota };
}

export function quotaSnapshot(pool: Pool, report: ServiceReport | undefined, at: number) {
	if (report?.status !== "ok" || report.service !== pool.service) {
		return null;
	}

	const windows = report.limits
		.filter((limit) => pool.windows.includes(limit.id))
		.map(({ id, usedPct, windowId, resetAtMs }) => ({
			id,
			usedPct,
			windowId: windowId ?? null,
			resetAtMs: resetAtMs ?? null,
		}));

	return windows.length > 0 ? { at, service: report.service, windows } : null;
}
