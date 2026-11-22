/** One limit of a service in the quota feed. */
export interface QuotaLimit {
	id: string;
	/** The limit's name on its service's plate. */
	label: string;
	/** Percent of the limit used. Above 100 when the service lets usage run past it. */
	usedPct: number;
	/** Epoch ms. */
	resetAtMs: number | null;
	/** Length of a rolling window. 300 and 10080 are the 5-hour and 7-day windows the dials draw. */
	windowMinutes: number | null;
}

export interface QuotaService {
	service: string;
	/** The service's display name. */
	label: string | null;
	status: "ok" | "signed-out" | "error";
	limits: QuotaLimit[];
}

/** Usage for any number of services, as one host job writes it. */
export interface QuotaFeed {
	/** Epoch ms. */
	generatedAt: number;
	services: QuotaService[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isName = (value: unknown): value is string => typeof value === "string" && value !== "";

const limitFrom = (limit: unknown): QuotaLimit => {
	if (
		!isRecord(limit) ||
		!isName(limit.id) ||
		!isName(limit.label) ||
		!isNumber(limit.usedPct) ||
		limit.usedPct < 0 ||
		!(limit.resetAtMs === undefined || limit.resetAtMs === null || isNumber(limit.resetAtMs)) ||
		!(
			limit.windowMinutes === undefined ||
			limit.windowMinutes === null ||
			(isNumber(limit.windowMinutes) && limit.windowMinutes > 0)
		)
	) {
		throw new Error("Invalid quota limit");
	}

	return {
		id: limit.id,
		label: limit.label,
		usedPct: limit.usedPct,
		resetAtMs: limit.resetAtMs ?? null,
		windowMinutes: limit.windowMinutes ?? null,
	};
};

const serviceFrom = (service: unknown): QuotaService => {
	if (
		!isRecord(service) ||
		typeof service.service !== "string" ||
		!/^[\w.-]+$/.test(service.service) ||
		!(service.label === undefined || service.label === null || isName(service.label)) ||
		(service.status !== "ok" && service.status !== "signed-out" && service.status !== "error") ||
		!Array.isArray(service.limits)
	) {
		throw new Error("Invalid quota service");
	}

	return {
		service: service.service,
		label: service.label ?? null,
		status: service.status,
		limits: service.limits.map(limitFrom),
	};
};

/**
 * The quota feed, or an error for one that is not exactly its shape: a figure that might be wrong
 * is not shown. Fields the feed is not meant to carry, such as a service's error text, are left
 * behind.
 */
export const parseQuotaFeed = (value: unknown): QuotaFeed => {
	if (!isRecord(value) || !isNumber(value.generatedAt) || !Array.isArray(value.services)) {
		throw new Error("Invalid quota feed");
	}

	const services = value.services.map(serviceFrom);

	if (new Set(services.map((service) => service.service)).size !== services.length) {
		throw new Error("Invalid quota feed: a service is listed twice");
	}

	return { generatedAt: value.generatedAt, services };
};
