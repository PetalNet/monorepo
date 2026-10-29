export interface ServiceCounts {
	up: number;
	down: number;
	pending: number;
	/** Failed heartbeats in the last hour. One flapping service can fail dozens of checks. */
	failedChecks1h: number;
	/** Distinct monitors with at least one failed heartbeat in the last hour. */
	failingServices1h: number;
	stale: boolean;
}

type Tone = "ok" | "warn" | "down";

const plural = (count: number, one: string, many: string) =>
	`${String(count)} ${count === 1 ? one : many}`;

/**
 * What the lab plate's services section says. Every number carries its own label, and the status
 * names what is wrong.
 */
export const servicesSummary = (services: ServiceCounts) => {
	const status: { label: string; tone: Tone } = services.stale
		? { label: "Stale", tone: "warn" }
		: services.down > 0
			? { label: `${String(services.down)} down`, tone: "down" }
			: services.pending > 0
				? { label: `${String(services.pending)} pending`, tone: "warn" }
				: { label: "All up", tone: "ok" };
	const stats: { label: string; count: number; alert: boolean }[] = [
		{ label: "Up", count: services.up, alert: false },
		{ label: "Down", count: services.down, alert: services.down > 0 },
		{ label: "Pending", count: services.pending, alert: false },
	];
	const recent =
		services.failedChecks1h === 0
			? null
			: `${plural(services.failedChecks1h, "failed check", "failed checks")} across ${plural(services.failingServices1h, "service", "services")} in the last hour`;

	return { status, stats, recent };
};
