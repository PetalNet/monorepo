/**
 * The only module in the app that can change anything.
 *
 * Kept apart from the read client on purpose. Everything else - the resolver, the reconciler, the
 * simulation - is structurally incapable of mutating Authentik, so a bug in the parts that run on
 * every page load cannot write. The blast radius of this app is the whole lab's access, and the
 * cheapest way to bound it is to make most of the code unable to reach the write path at all.
 */

/** Thrown, not constructed by callers, so the type is exported and the class is not. */
export type { AuthentikWriteError };

class AuthentikWriteError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "AuthentikWriteError";
	}
}

export interface AuthentikWriterOptions {
	baseUrl: string;
	token: string;
	fetch?: typeof globalThis.fetch;
}

export class AuthentikWriter {
	readonly #baseUrl: string;
	readonly #token: string;
	readonly #fetch: typeof globalThis.fetch;

	constructor(options: AuthentikWriterOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/$/, "");
		this.#token = options.token;
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	async #post(path: string, body: unknown): Promise<void> {
		const response = await this.#fetch(`${this.#baseUrl}${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			// Include the body: Authentik explains refusals in it, and swallowing that turns a
			// fixable "group does not exist" into an opaque 400.
			const detail = await response.text().catch(() => "");
			throw new AuthentikWriteError(
				`Authentik refused ${path} with ${String(response.status)}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
				response.status,
			);
		}
	}

	addUserToGroup(groupUuid: string, userPk: number): Promise<void> {
		return this.#post(`/core/groups/${groupUuid}/add_user/`, { pk: userPk });
	}

	removeUserFromGroup(groupUuid: string, userPk: number): Promise<void> {
		return this.#post(`/core/groups/${groupUuid}/remove_user/`, { pk: userPk });
	}
}
