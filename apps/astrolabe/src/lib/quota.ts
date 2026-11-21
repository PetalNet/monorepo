export interface QuotaLimit {
	id: string;
	label: string;
	usedPct: number;
	resetAtMs: number | null;
	resetLabel: string | null;
}

export interface QuotaService {
	service: string;
	status: "ok" | "signed-out" | "error";
	limits: QuotaLimit[];
}

export interface QuotaFeed {
	generatedAt: number;
	services: QuotaService[];
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function parseQuotaFeed(value: unknown): QuotaFeed {
	if (
		!record(value) ||
		typeof value.generatedAt !== "number" ||
		!Number.isFinite(value.generatedAt) ||
		!Array.isArray(value.services)
	) {
		throw new Error("Invalid quota feed");
	}

	const services: QuotaService[] = value.services.map((service: unknown) => {
		if (
			!record(service) ||
			typeof service.service !== "string" ||
			!service.service ||
			(service.status !== "ok" && service.status !== "error" && service.status !== "signed-out") ||
			!Array.isArray(service.limits)
		) {
			throw new Error("Invalid quota service");
		}

		const limits: QuotaLimit[] = service.limits.map((limit: unknown) => {
			if (
				!record(limit) ||
				typeof limit.id !== "string" ||
				!limit.id ||
				typeof limit.label !== "string" ||
				typeof limit.usedPct !== "number" ||
				!Number.isFinite(limit.usedPct) ||
				limit.usedPct < 0 ||
				(limit.resetAtMs != null &&
					(typeof limit.resetAtMs !== "number" || !Number.isFinite(limit.resetAtMs))) ||
				(limit.resetLabel != null && typeof limit.resetLabel !== "string")
			) {
				throw new Error("Invalid quota limit");
			}

			return {
				id: limit.id,
				label: limit.label,
				usedPct: limit.usedPct,
				resetAtMs: limit.resetAtMs ?? null,
				resetLabel: limit.resetLabel ?? null,
			};
		});

		return { service: service.service, status: service.status, limits };
	});

	return { generatedAt: value.generatedAt, services };
}

export const quotaStale = (feed: QuotaFeed, now: number): boolean =>
	feed.generatedAt > now || now - feed.generatedAt > 15 * 60 * 1000;
