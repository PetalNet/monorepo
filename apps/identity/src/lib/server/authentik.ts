/**
 * Read-only Authentik client.
 *
 * Authentik stays the authentication source of truth; this app never reimplements sessions, MFA
 * or OAuth. Everything here is a GET. Mutation lives behind the change engine, which simulates
 * and verifies, and it is deliberately not in this file so that nothing can mutate by accident.
 *
 * The important call is `checkAccess`. Authentik will evaluate its own policies for a named user
 * and tell you the answer, which gives a truthful per-person result for every SSO application
 * with no connector work and no impersonation. That is the EVALUATED state: weaker than probing
 * the application itself, far stronger than reading configuration and hoping.
 */

export interface AuthentikUser {
	pk: number;
	username: string;
	name: string;
	email: string;
	is_active: boolean;
	type: string;
	groups_obj: { pk: string; name: string }[];
	attributes: Record<string, unknown>;
}

export interface AuthentikGroup {
	pk: string;
	name: string;
	users_obj: { pk: number; username: string }[];
}

export interface AuthentikApplication {
	pk: string;
	name: string;
	slug: string;
	meta_launch_url: string;
	provider_obj?: { name: string; component: string; external_host?: string };
}

export interface AuthentikBinding {
	pk: string;
	target: string;
	group?: string;
	user?: number;
	policy?: string;
	enabled: boolean;
	negate: boolean;
	order: number;
	group_obj?: { pk: string; name: string };
	policy_obj?: { name: string };
}

export class AuthentikError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly path: string,
	) {
		super(message);
		this.name = "AuthentikError";
	}
}

export interface AuthentikClientOptions {
	baseUrl: string;
	token: string;
	fetch?: typeof globalThis.fetch;
}

export class AuthentikClient {
	readonly #baseUrl: string;
	readonly #token: string;
	readonly #fetch: typeof globalThis.fetch;

	constructor(options: AuthentikClientOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/$/, "");
		this.#token = options.token;
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	/**
	 * Every failure throws. A connector that turns an error into an empty list is the exact bug
	 * this product is meant to catch: "no users found" and "the request failed" must never render
	 * the same, or a broken connector shows up as a clean bill of health.
	 */
	async #get<T>(path: string): Promise<T> {
		let response: Response;
		try {
			response = await this.#fetch(`${this.#baseUrl}${path}`, {
				headers: { Authorization: `Bearer ${this.#token}` },
			});
		} catch (cause) {
			throw new AuthentikError(`Authentik unreachable: ${String(cause)}`, 0, path);
		}
		if (!response.ok) {
			throw new AuthentikError(
				`Authentik returned ${String(response.status)} for ${path}`,
				response.status,
				path,
			);
		}
		return (await response.json()) as T;
	}

	/**
	 * Authentik paginates. Following the pagination is not optional: a silently truncated first
	 * page would under-report who can reach a resource, which is a security answer that is wrong
	 * in the dangerous direction.
	 */
	async #list<T>(path: string): Promise<T[]> {
		const separator = path.includes("?") ? "&" : "?";

		// Recursive rather than a loop: page N+1's existence is only knowable from page N's
		// response, so the sequencing is inherent. Recursion states that; a loop hides it.
		const fetchFrom = async (page: number, collected: T[]): Promise<T[]> => {
			const body = await this.#get<{
				results: T[];
				pagination?: { next: number; total_pages: number };
			}>(`${path}${separator}page_size=100&page=${String(page)}`);
			const all = [...collected, ...body.results];
			const pagination = body.pagination;
			if (!pagination || page >= pagination.total_pages) return all;
			return fetchFrom(page + 1, all);
		};

		return fetchFrom(1, []);
	}

	users(): Promise<AuthentikUser[]> {
		return this.#list<AuthentikUser>("/core/users/");
	}

	groups(): Promise<AuthentikGroup[]> {
		return this.#list<AuthentikGroup>("/core/groups/");
	}

	applications(): Promise<AuthentikApplication[]> {
		return this.#list<AuthentikApplication>("/core/applications/");
	}

	bindings(): Promise<AuthentikBinding[]> {
		return this.#list<AuthentikBinding>("/policies/bindings/");
	}

	/**
	 * Ask Authentik whether a specific real user passes an application's policies.
	 *
	 * This is the EVALUATED state. It is authoritative for the SSO path and requires no
	 * credentials of theirs, but it says nothing about a local account inside the application,
	 * which is why local-identity discovery remains a separate and necessary signal.
	 */
	async checkAccess(slug: string, userPk: number): Promise<boolean> {
		const body = await this.#get<{ passing: boolean }>(
			`/core/applications/${slug}/check_access/?for_user=${String(userPk)}`,
		);
		return body.passing;
	}
}

/**
 * Applications with no policy binding at all.
 *
 * Authentik's default for an unbound application is to let every authenticated account in, which
 * reads as "no configuration yet" and behaves as "open to everyone". Naming them explicitly is
 * the single most valuable thing this product does before any new account is created.
 */
export function unboundApplications(
	applications: AuthentikApplication[],
	bindings: AuthentikBinding[],
): AuthentikApplication[] {
	const bound = new Set(bindings.filter((b) => b.enabled).map((b) => b.target));
	return applications.filter((app) => !bound.has(app.pk));
}
