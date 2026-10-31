export interface KumaMonitor {
	id: number;
	name: string;
}

export interface ServiceCounts {
	up: number;
	/** Active monitors whose latest heartbeat is down, by name, so the plate can link each one. */
	down: KumaMonitor[];
	pending: number;
	/** Failed heartbeats in the last hour. One flapping service can fail dozens of checks. */
	failedChecks1h: number;
	/** Distinct monitors with at least one failed heartbeat in the last hour. */
	failingServices1h: number;
	stale: boolean;
}

const plural = (count: number, one: string, many: string) =>
	`${String(count)} ${count === 1 ? one : many}`;

/**
 * What the lab plate's services section says. The Down figure carries the down count, so the status
 * only speaks when nothing is down. Links point at Uptime Kuma's dashboard when `kumaUrl` is set.
 */
export const servicesSummary = (services: ServiceCounts, kumaUrl: string | null) => {
	const down = services.down.length;
	const status = services.stale
		? "Stale"
		: down > 0
			? null
			: services.pending > 0
				? `${String(services.pending)} pending`
				: "All up";
	const stats: { label: string; count: number; alert: boolean }[] = [
		{ label: "Up", count: services.up, alert: false },
		{ label: "Down", count: down, alert: down > 0 },
		{ label: "Pending", count: services.pending, alert: false },
	];
	const recent =
		services.failedChecks1h === 0
			? null
			: `${plural(services.failedChecks1h, "failed check", "failed checks")} across ${plural(services.failingServices1h, "service", "services")} in the last hour`;

	return {
		status,
		stats,
		recent,
		href: kumaUrl === null ? null : `${kumaUrl}/dashboard`,
		down: services.down.map((monitor) => ({
			id: monitor.id,
			name: monitor.name,
			href: kumaUrl === null ? null : `${kumaUrl}/dashboard/${String(monitor.id)}`,
		})),
	};
};
