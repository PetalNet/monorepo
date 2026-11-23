import type { ServiceReport } from "@petalnet/harness-hooks/quota-sources";

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
