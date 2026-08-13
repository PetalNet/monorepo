/**
 * Invitations: the claim-link half of onboarding.
 *
 * An invitation token IS the credential. Whoever holds the link becomes that account, so these are
 * minted single-use with an expiry, and the UI shows each link exactly once at creation. That is
 * not caution theatre: a link that lingers in a list is a standing credential that nobody remembers
 * issuing.
 *
 * This does not create accounts. The person creates their own by claiming, which is the point -
 * they choose their password and it never passes through anyone else.
 */

import type { AuthentikWriter } from "./authentik-write";

/** A person to invite. `username` is pinned so the invitee cannot choose an arbitrary one. */
export interface InviteRequest {
	username: string;
	displayName: string;
	email?: string;
}

export interface Invitation {
	token: string;
	username: string;
	displayName: string;
	claimUrl: string;
	expires: string;
	singleUse: boolean;
}

export interface InviteFailure {
	username: string;
	reason: string;
}

export interface InviteOutcome {
	created: Invitation[];
	failed: InviteFailure[];
}

/** Authentik slugs are lowercase alphanumeric plus dashes; an invitation name must be one. */
function toInvitationName(username: string, stamp: string): string {
	const safe = username
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "");
	return `claim-${safe || "user"}-${stamp}`;
}

function claimUrl(baseUrl: string, flowSlug: string, token: string): string {
	return `${baseUrl.replace(/\/$/, "")}/if/flow/${flowSlug}/?itoken=${token}`;
}

/**
 * Reject a request rather than quietly normalising it into something else.
 *
 * A username that silently becomes a different username produces an account nobody can find and a
 * claim link that works for the wrong identity.
 */
function validateInvite(request: InviteRequest): string | null {
	const username = request.username.trim();
	if (!username) return "username is empty";
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(username)) {
		return `"${username}" is not a usable username (letters, digits, dot, dash, underscore)`;
	}
	if (username.length > 64) return `"${username}" is too long`;
	if (request.email && !request.email.includes("@")) return `"${request.email}" is not an email`;
	return null;
}

/** Reject duplicates inside one batch before anything is created. */
function findDuplicates(requests: InviteRequest[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const request of requests) {
		const key = request.username.trim().toLowerCase();
		if (seen.has(key)) duplicates.add(key);
		seen.add(key);
	}
	return [...duplicates];
}

export interface MintOptions {
	writer: AuthentikWriter;
	flowPk: string;
	flowSlug: string;
	publicBaseUrl: string;
	expiresAt: Date;
	stamp: string;
	/**
	 * Consumed on first open rather than on completion, so true is only safe when the link is
	 * delivered somewhere that will not prefetch it.
	 */
	singleUse: boolean;
	/** Usernames Authentik already has, so an invitation is never minted for an existing account. */
	existingUsernames: Set<string>;
}

/**
 * Mint one invitation per request.
 *
 * Each is independent: one bad row does not abandon the batch, and the caller gets both halves
 * back. Abandoning the whole batch on a single failure is worse here than partial success, because
 * the alternative is an operator re-running it and double-inviting everyone who worked.
 */
export async function mintInvitations(
	requests: InviteRequest[],
	options: MintOptions,
): Promise<InviteOutcome> {
	const created: Invitation[] = [];
	const failed: InviteFailure[] = [];
	const duplicates = new Set(findDuplicates(requests));

	// Everything rejectable without talking to Authentik is rejected first, so a bad row never
	// costs a round trip and the batch below contains only real work.
	const admissible: { request: InviteRequest; username: string }[] = [];
	for (const request of requests) {
		const username = request.username.trim();
		const problem = validateInvite(request);
		if (problem) failed.push({ username, reason: problem });
		else if (duplicates.has(username.toLowerCase()))
			failed.push({ username, reason: "listed more than once in this batch" });
		else if (options.existingUsernames.has(username.toLowerCase()))
			failed.push({ username, reason: "an account with this username already exists" });
		else admissible.push({ request, username });
	}

	// Independent writes, so they go together rather than one round trip per person. map keeps
	// the order, so links come back in the order they were listed.
	const results = await Promise.all(
		admissible.map(async ({ request, username }) => {
			const displayName = request.displayName.trim() || username;
			try {
				const token = await options.writer.createInvitation({
					name: toInvitationName(username, options.stamp),
					expires: options.expiresAt.toISOString(),
					flow: options.flowPk,
					singleUse: options.singleUse,
					// Prefills the signup prompt so the invitee cannot pick a different username.
					fixedData: {
						username,
						name: displayName,
						...(request.email ? { email: request.email.trim() } : {}),
					},
				});
				return {
					ok: true as const,
					invitation: {
						token,
						username,
						displayName,
						claimUrl: claimUrl(options.publicBaseUrl, options.flowSlug, token),
						expires: options.expiresAt.toISOString(),
						singleUse: options.singleUse,
					},
				};
			} catch (cause) {
				return { ok: false as const, username, reason: String(cause).slice(0, 200) };
			}
		}),
	);

	for (const result of results) {
		if (result.ok) created.push(result.invitation);
		else failed.push({ username: result.username, reason: result.reason });
	}

	return { created, failed };
}

/**
 * Parse a pasted roster: one person per line.
 *
 * Accepts `username`, `username, Display Name`, or `username, Display Name, email`. Blank lines and
 * `#` comments are skipped so an operator can annotate a list they are working through.
 *
 * A line it cannot read comes back in `malformed` rather than being dropped. Silently skipping a
 * line means someone does not get invited and nobody finds out until they ask why.
 */
export function parseRoster(text: string): { requests: InviteRequest[]; malformed: string[] } {
	const requests: InviteRequest[] = [];
	const malformed: string[] = [];

	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const parts = line.split(",").map((part) => part.trim());
		const username = parts[0];
		if (!username) {
			malformed.push(raw);
			continue;
		}
		requests.push({
			username,
			displayName: parts[1] ?? "",
			...(parts[2] ? { email: parts[2] } : {}),
		});
	}

	return { requests, malformed };
}
