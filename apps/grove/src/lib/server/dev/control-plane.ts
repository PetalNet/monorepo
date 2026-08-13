import process from "node:process";

import { dev } from "$app/env";

const returnToBase = "https://grove.invalid";

export const isGroveDevControlPlaneEnabled = (development: boolean, flag: string | undefined) =>
	development && flag === "1";

export const groveDevControlPlaneEnabled = () =>
	isGroveDevControlPlaneEnabled(dev, process.env.GROVE_ORB_DEV_AUTH);

export const devRouteNotFound = () => new Response("Not found", { status: 404 });

export const safeReturnTo = (candidate: string | null | undefined) => {
	if (!candidate?.startsWith("/") || candidate.startsWith("//")) return "/";
	try {
		const parsed = new URL(candidate, returnToBase);
		return parsed.origin === returnToBase
			? `${parsed.pathname}${parsed.search}${parsed.hash}`
			: "/";
	} catch {
		return "/";
	}
};

export const devEndpointInventory = (origin: string) => ({
	status: "development-only" as const,
	productionBoundary:
		"Every endpoint in this inventory returns 404 unless SvelteKit development mode and GROVE_ORB_DEV_AUTH=1 are both active.",
	instructions: {
		ensureServices: ".agents/ensure-grove",
		portalManifests: ".amp/portals/grove.json and .amp/portals/grove-oidc.json",
		logs: ".amp/in/grove.log, .amp/in/grove-oidc.log, and .amp/in/grove-browser.log",
	},
	endpoints: {
		index: { method: "GET", href: `${origin}/__dev` },
		login: {
			method: "GET",
			href: `${origin}/__dev/log-me-in/operator?returnTo=/`,
			behavior:
				"Redirect alias into the real auto-approved Authorization Code + PKCE + nonce OIDC flow; expect OIDC redirects before the returnTo path.",
		},
		logout: {
			method: "GET",
			href: `${origin}/__dev/log-me-out?returnTo=/`,
			behavior: "Deletes the Better Auth session, clears its browser cookie, then redirects.",
		},
		preflight: { method: "GET", href: `${origin}/__dev/preflight` },
		browserLogs: { method: "POST", href: `${origin}/__dev/logs/browser` },
	},
});

type HomeReadiness =
	| {
			readonly status: "owner-unbound";
			readonly configuredIdentity: { readonly issuer: string; readonly subject: string };
	  }
	| {
			readonly status: "owner-config-mismatch";
			readonly configuredIdentity: { readonly issuer: string; readonly subject: string };
			readonly ownerPersonId: string;
	  }
	| {
			readonly status: "owner-not-current";
			readonly ownerPersonId: string;
			readonly lifecycle: "dormant" | "suspended" | "retired";
	  }
	| { readonly status: "ready"; readonly ownerPersonId: string };

interface DevPreflightConfig {
	readonly groveOrigin: string;
	readonly browserIssuer: string;
	readonly mcpIssuer: string;
	readonly mcpResourceOrigin: string;
	readonly mcpClientCredentialsAvailable: boolean;
}

interface BrowserActor {
	readonly kind: "person";
	readonly actorId: string;
	readonly name: string;
	readonly authUserId?: string;
}

interface DevPreflightInput {
	readonly requestOrigin: string;
	readonly config: DevPreflightConfig;
	readonly homeReadiness: HomeReadiness | undefined;
	readonly actor: BrowserActor | null;
	readonly fetch?: typeof fetch;
}

type CheckStatus = "pass" | "fail" | "action-required" | "not-authenticated";

interface DevPreflightCheck {
	readonly id: string;
	readonly required: boolean;
	readonly status: CheckStatus;
	readonly summary: string;
	readonly repair?: string;
	readonly details?: object;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const stringArray = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	return value.every((entry: unknown): entry is string => typeof entry === "string")
		? value
		: undefined;
};

const authorizationServerMetadataUrl = (issuer: string) => {
	const parsed = new URL(issuer);
	return `${parsed.origin}/.well-known/oauth-authorization-server${parsed.pathname}`;
};

const fetchMetadata = async (fetcher: typeof fetch, url: string) => {
	try {
		const response = await fetcher(url, { signal: AbortSignal.timeout(5_000) });
		if (!response.ok) return undefined;
		return record(await response.json());
	} catch {
		return undefined;
	}
};

const endpointHasOrigin = (value: unknown, origin: string) => {
	if (typeof value !== "string") return false;
	try {
		return new URL(value).origin === origin;
	} catch {
		return false;
	}
};

const databaseCheck = (readiness: HomeReadiness | undefined): DevPreflightCheck =>
	readiness
		? {
				id: "database-runtime",
				required: true,
				status: "pass",
				summary: "Grove runtime reached the durable Actor authority.",
			}
		: {
				id: "database-runtime",
				required: true,
				status: "fail",
				summary: "Grove runtime could not read durable Actor authority state.",
				repair: "Run .agents/ensure-grove, then inspect .amp/in/grove.log.",
			};

const homeOwnerCheck = (readiness: HomeReadiness | undefined): DevPreflightCheck => {
	if (!readiness)
		return {
			id: "home-host-owner",
			required: true,
			status: "fail",
			summary: "Home Host owner binding could not be inspected.",
			repair: "Repair database/runtime readiness before inspecting the Home Host owner.",
		};
	if (readiness.status === "owner-unbound")
		return {
			id: "home-host-owner",
			required: false,
			status: "action-required",
			summary: "The configured owner has not completed browser login yet.",
			repair: "Open /__dev/log-me-in/operator?returnTo=/ once before enrolling an Agent.",
			details: { configuredIdentity: readiness.configuredIdentity },
		};
	if (readiness.status === "owner-config-mismatch")
		return {
			id: "home-host-owner",
			required: true,
			status: "fail",
			summary: "The bound Home Host owner does not match current configuration.",
			repair:
				"Restore GROVE_HOME_OWNER_ISSUER and GROVE_HOME_OWNER_SUBJECT to the bound owner; configuration changes never transfer ownership.",
			details: {
				configuredIdentity: readiness.configuredIdentity,
				ownerPersonId: readiness.ownerPersonId,
			},
		};
	if (readiness.status === "owner-not-current")
		return {
			id: "home-host-owner",
			required: true,
			status: "fail",
			summary: "The bound Home Host owner is not active.",
			repair: "Restore the existing owner Actor to active state before using Grove.",
			details: {
				ownerPersonId: readiness.ownerPersonId,
				lifecycle: readiness.lifecycle,
			},
		};
	return {
		id: "home-host-owner",
		required: true,
		status: "pass",
		summary: "The configured Home Host owner is bound and current.",
		details: { ownerPersonId: readiness.ownerPersonId },
	};
};

const browserSessionCheck = (actor: BrowserActor | null): DevPreflightCheck =>
	actor
		? {
				id: "browser-session",
				required: false,
				status: "pass",
				summary: "This request carries a current Better Auth browser session and Person Actor.",
				details: {
					authenticated: true,
					actor: { kind: actor.kind, actorId: actor.actorId, name: actor.name },
				},
			}
		: {
				id: "browser-session",
				required: false,
				status: "not-authenticated",
				summary: "No current browser session was supplied; environment readiness is unaffected.",
				repair:
					"Use /__dev/log-me-in/operator?returnTo=/ in the browser when authentication is needed.",
				details: { authenticated: false, actor: null },
			};

export const runDevPreflight = async (input: DevPreflightInput) => {
	const fetcher = input.fetch ?? globalThis.fetch;
	const browserIssuerOrigin = new URL(input.config.browserIssuer).origin;
	const mcpIssuerOrigin = new URL(input.config.mcpIssuer).origin;
	const [browserDiscovery, protectedResource, authorizationServer] = await Promise.all([
		fetchMetadata(
			fetcher,
			`${input.config.browserIssuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
		),
		fetchMetadata(fetcher, `${input.config.groveOrigin}/.well-known/oauth-protected-resource/mcp`),
		fetchMetadata(fetcher, authorizationServerMetadataUrl(input.config.mcpIssuer)),
	]);

	const browserDiscoveryHealthy =
		browserDiscovery?.issuer === input.config.browserIssuer &&
		endpointHasOrigin(browserDiscovery.authorization_endpoint, browserIssuerOrigin) &&
		endpointHasOrigin(browserDiscovery.token_endpoint, browserIssuerOrigin) &&
		endpointHasOrigin(browserDiscovery.jwks_uri, browserIssuerOrigin);
	const protectedResourceHealthy =
		protectedResource?.resource === `${input.config.mcpResourceOrigin}/mcp` &&
		stringArray(protectedResource.authorization_servers)?.includes(input.config.mcpIssuer) ===
			true &&
		stringArray(protectedResource.bearer_methods_supported)?.includes("header") === true &&
		stringArray(protectedResource.scopes_supported)?.includes("grove:mcp") === true &&
		stringArray(protectedResource.scopes_supported)?.includes("grove:agent:enroll") === true;
	const authorizationServerHealthy =
		authorizationServer?.issuer === input.config.mcpIssuer &&
		endpointHasOrigin(authorizationServer.token_endpoint, mcpIssuerOrigin) &&
		endpointHasOrigin(authorizationServer.jwks_uri, mcpIssuerOrigin) &&
		stringArray(authorizationServer.grant_types_supported)?.includes("client_credentials") ===
			true &&
		stringArray(authorizationServer.token_endpoint_auth_methods_supported)?.includes(
			"client_secret_basic",
		) === true;
	const requestOrigin = new URL(input.requestOrigin);
	const groveOrigin = new URL(input.config.groveOrigin);
	const requestMatchesPublicOrigin =
		requestOrigin.origin === groveOrigin.origin ||
		(requestOrigin.protocol === "http:" &&
			groveOrigin.protocol === "https:" &&
			requestOrigin.host === groveOrigin.host);
	const groveOriginsHealthy =
		groveOrigin.protocol === "https:" &&
		requestMatchesPublicOrigin &&
		input.config.mcpResourceOrigin === input.config.groveOrigin;
	const oidcOriginsHealthy =
		browserIssuerOrigin === mcpIssuerOrigin &&
		new URL(input.config.browserIssuer).protocol === "https:" &&
		new URL(input.config.mcpIssuer).protocol === "https:";

	const checks: DevPreflightCheck[] = [
		databaseCheck(input.homeReadiness),
		homeOwnerCheck(input.homeReadiness),
		browserSessionCheck(input.actor),
		groveOriginsHealthy
			? {
					id: "grove-public-origin",
					required: true,
					status: "pass",
					summary: "Request, browser callback, and MCP resource use Grove's public origin.",
					details: { origin: input.config.groveOrigin },
				}
			: {
					id: "grove-public-origin",
					required: true,
					status: "fail",
					summary: "Grove public-origin configuration does not match this request.",
					repair:
						"Run .agents/ensure-grove so BETTER_AUTH_URL and GROVE_MCP_RESOURCE come from the Grove portal manifest.",
				},
		oidcOriginsHealthy
			? {
					id: "oidc-public-origin",
					required: true,
					status: "pass",
					summary: "Browser and MCP issuers use the configured HTTPS OIDC portal origin.",
					details: { origin: browserIssuerOrigin },
				}
			: {
					id: "oidc-public-origin",
					required: true,
					status: "fail",
					summary: "Development issuers do not share one HTTPS OIDC portal origin.",
					repair:
						"Run .agents/ensure-grove so browser and MCP issuer URLs come from the OIDC portal manifest.",
				},
		browserDiscoveryHealthy
			? {
					id: "browser-oidc-discovery",
					required: true,
					status: "pass",
					summary: "Browser OIDC discovery matches the pinned issuer and origin.",
				}
			: {
					id: "browser-oidc-discovery",
					required: true,
					status: "fail",
					summary: "Browser OIDC discovery is unavailable or inconsistent.",
					repair: "Run .agents/ensure-grove, then inspect .amp/in/grove-oidc.log.",
				},
		protectedResourceHealthy
			? {
					id: "mcp-protected-resource",
					required: true,
					status: "pass",
					summary: "MCP protected-resource discovery publishes exact resource and scopes.",
				}
			: {
					id: "mcp-protected-resource",
					required: true,
					status: "fail",
					summary: "MCP protected-resource discovery is unavailable or inconsistent.",
					repair: "Run .agents/ensure-grove, then inspect .amp/in/grove.log.",
				},
		authorizationServerHealthy
			? {
					id: "mcp-authorization-server",
					required: true,
					status: "pass",
					summary: "MCP authorization-server discovery supports development machine auth.",
				}
			: {
					id: "mcp-authorization-server",
					required: true,
					status: "fail",
					summary: "MCP authorization-server discovery is unavailable or inconsistent.",
					repair: "Run .agents/ensure-grove, then inspect .amp/in/grove-oidc.log.",
				},
		input.config.mcpClientCredentialsAvailable
			? {
					id: "dev-mcp-credentials",
					required: true,
					status: "pass",
					summary:
						"Development MCP client credentials are configured for explicit Agent enrollment.",
					details: { available: true },
				}
			: {
					id: "dev-mcp-credentials",
					required: true,
					status: "fail",
					summary: "Development MCP client credentials are unavailable.",
					repair:
						"Run .agents/ensure-grove to restore the development MCP credential configuration.",
					details: { available: false },
				},
	];
	const requiredHealthy = checks.every((check) => !check.required || check.status === "pass");
	return {
		status: requiredHealthy ? ("ready" as const) : ("not-ready" as const),
		readyForLogin: requiredHealthy,
		readyForAgentEnrollment: requiredHealthy && input.homeReadiness?.status === "ready",
		checks,
	};
};
