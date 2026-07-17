import type { DeliveryReceiptView } from "./signals.ts";

export type DeliveryLineState = "healthy" | "failing" | "unconfigured" | "unverifiable";

export interface DeliveryLineHealth {
	state: DeliveryLineState;
	summary: string;
	detail: string;
	failingSince: string | null;
	flapping: boolean;
	cycleCount: number;
	backupInterrupts: DeliveryReceiptView[];
}

interface DeliveryLineInput {
	target: string | null;
	receipts: readonly DeliveryReceiptView[];
	matrixSyncOkEpoch: number | null;
	busObservedAt: string | null;
	now?: number;
}

const FAILURE_WINDOW_MS = 10 * 60_000;
const FLAP_WINDOW_MS = 60 * 60_000;
const DAMPING_MS = 10 * 60_000;
const MATRIX_FRESH_MS = 120_000;
const BUS_FRESH_MS = 90_000;

function compactAge(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	if (seconds < 60) return `${String(seconds)}s`;
	if (seconds < 3_600) return `${String(Math.floor(seconds / 60))}m`;
	return `${String(Math.floor(seconds / 3_600))}h`;
}

function validTime(value: string | null): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The spec-11 line-health rule in one deterministic seam. A quiet channel is never called healthy
 * without fresh positive evidence, and repeat fail/recover cycles remain one damped incident
 * instead of re-fracturing the console on every receipt.
 */
export function deriveDeliveryLineHealth(input: DeliveryLineInput): DeliveryLineHealth {
	const now = input.now ?? Date.now();
	if (!input.target)
		return {
			state: "unconfigured",
			summary: "The Mindy Line is not connected.",
			detail: "Interrupts show only here in the console until it is.",
			failingSince: null,
			flapping: false,
			cycleCount: 0,
			backupInterrupts: [],
		};

	const receipts = [...input.receipts]
		.filter((receipt) => validTime(receipt.ts) !== null)
		.toSorted((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
	const inHour = receipts.filter((receipt) => now - Date.parse(receipt.ts) <= FLAP_WINDOW_MS);
	const chronological = inHour.toReversed();
	const failureRuns: DeliveryReceiptView[][] = [];
	for (const receipt of chronological) {
		if (receipt.status === "failed") {
			const run = failureRuns.at(-1);
			if (run && chronological.indexOf(receipt) > 0) {
				const previous = chronological[chronological.indexOf(receipt) - 1];
				if (previous.status === "failed") {
					run.push(receipt);
					continue;
				}
			}
			failureRuns.push([receipt]);
		}
	}
	const qualifyingRuns = failureRuns.filter((run) => {
		if (run.length < 2) return false;
		const first = Date.parse(run[0].ts);
		const last = Date.parse(run.at(-1)?.ts ?? "");
		return last - first <= FAILURE_WINDOW_MS;
	});
	const cycleCount = qualifyingRuns.length;
	const latestReceipt = receipts[0] ?? null;
	const currentRun = latestReceipt.status === "failed" ? failureRuns.at(-1) : null;
	const currentReceiptFailure = Boolean(
		currentRun &&
		currentRun.length >= 2 &&
		Date.parse(currentRun.at(-1)?.ts ?? "") - Date.parse(currentRun[0].ts) <= FAILURE_WINDOW_MS &&
		now - Date.parse(currentRun.at(-1)?.ts ?? "") <= FAILURE_WINDOW_MS,
	);
	const matrixSyncAt =
		input.matrixSyncOkEpoch && input.matrixSyncOkEpoch > 0 ? input.matrixSyncOkEpoch * 1_000 : null;
	const matrixSyncStale = matrixSyncAt !== null && now - matrixSyncAt > MATRIX_FRESH_MS;
	const damping =
		cycleCount >= 2 &&
		latestReceipt.status === "delivered" &&
		now - Date.parse(latestReceipt.ts) < DAMPING_MS;
	const failing = currentReceiptFailure || matrixSyncStale || damping;
	const flapping = cycleCount >= 2 && failing;

	if (failing) {
		const receiptSince = currentReceiptFailure
			? (currentRun?.[0]?.ts ?? null)
			: damping
				? (qualifyingRuns[0]?.[0]?.ts ?? null)
				: null;
		const syncSince = matrixSyncStale
			? new Date(matrixSyncAt + MATRIX_FRESH_MS).toISOString()
			: null;
		const failingSince =
			[receiptSince, syncSince].filter((value): value is string => value !== null).toSorted()[0] ??
			null;
		const details = [
			matrixSyncStale ? `Matrix sync ${compactAge(now - matrixSyncAt)} stale` : null,
			flapping ? `flapping, ${String(cycleCount)} cycles this hour` : null,
			damping ? "holding one incident through the 10m damping interval" : null,
		]
			.filter((value): value is string => Boolean(value))
			.join(" · ");
		return {
			state: "failing",
			summary: "Matrix delivery failing. Interrupts are NOT reaching you. Shown here as backup.",
			detail: details || `${String(currentRun?.length ?? 0)} consecutive sends failed`,
			failingSince,
			flapping,
			cycleCount,
			backupInterrupts: receipts.filter(
				(receipt) =>
					receipt.status === "failed" &&
					receipt.tier === "interrupt" &&
					(!failingSince || receipt.ts >= failingSince),
			),
		};
	}

	const busAt = validTime(input.busObservedAt);
	const busAge = busAt === null ? null : now - busAt;
	const busFresh = busAge !== null && busAge <= BUS_FRESH_MS;
	const matrixFresh = matrixSyncAt !== null && now - matrixSyncAt <= MATRIX_FRESH_MS;
	if (latestReceipt.status !== "delivered" || !busFresh || !matrixFresh) {
		const detail =
			busAge !== null && !busFresh
				? `Bus silent ${compactAge(busAge)}.`
				: latestReceipt.status === "failed"
					? "One failed receipt; waiting for corroboration."
					: !matrixFresh
						? "Matrix sync has no fresh proof."
						: "No delivered receipt yet.";
		return {
			state: "unverifiable",
			summary: `Can't verify. ${detail}`,
			detail,
			failingSince: null,
			flapping: false,
			cycleCount,
			backupInterrupts: [],
		};
	}

	return {
		state: "healthy",
		summary: "The Mindy Line reaches you off-console. Interrupts only.",
		detail: "Latest receipt delivered and the Matrix executor is fresh.",
		failingSince: null,
		flapping: false,
		cycleCount,
		backupInterrupts: [],
	};
}
