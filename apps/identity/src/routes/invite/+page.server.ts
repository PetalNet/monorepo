import { env } from "$env/dynamic/private";
import { AuthentikClient } from "$lib/server/authentik";
import { unboundApplications } from "$lib/server/authentik";
import { AuthentikWriter } from "$lib/server/authentik-write";
import { onboardingGate } from "$lib/server/findings";
import { mintInvitations, parseRoster } from "$lib/server/invitations";
import { error, fail } from "@sveltejs/kit";

import type { Actions, PageServerLoad } from "./$types";

const FLOW_SLUG = "petalnet-migration";
const DEFAULT_DAYS = 7;

function config(): { url: string; token: string; publicUrl: string } {
	const url = env.AUTHENTIK_URL;
	const token = env.AUTHENTIK_TOKEN;
	const publicUrl = env.AUTHENTIK_PUBLIC_URL;
	if (!url || !token || !publicUrl) {
		error(
			500,
			"AUTHENTIK_URL, AUTHENTIK_TOKEN and AUTHENTIK_PUBLIC_URL must all be set. The public " +
				"URL is what invitees click, so it cannot be guessed from the internal one.",
		);
	}
	return { url, token, publicUrl };
}

export const load: PageServerLoad = async () => {
	const { url, token } = config();
	const client = new AuthentikClient({ baseUrl: url, token });

	const [applications, bindings, users] = await Promise.all([
		client.applications(),
		client.bindings(),
		client.users(),
	]);

	// The gate is enforced here as well as displayed. Inviting people while applications still
	// admit every authenticated account is the exact sequencing mistake this exists to prevent,
	// and a warning nobody is forced to read is not a control.
	const gate = onboardingGate(unboundApplications(applications, bindings));

	return {
		gate,
		existing: users
			.filter((u) => u.type === "internal")
			.map((u) => u.username)
			.toSorted(),
		defaultDays: DEFAULT_DAYS,
	};
};

export const actions: Actions = {
	invite: async ({ request }) => {
		const { url, token, publicUrl } = config();
		const form = await request.formData();
		const rosterValue = form.get("roster");
		const roster = typeof rosterValue === "string" ? rosterValue : "";
		const singleUse = form.get("singleUse") === "on";
		const daysValue = form.get("days");
		const days = Number(typeof daysValue === "string" ? daysValue : DEFAULT_DAYS);

		if (!Number.isFinite(days) || days < 1 || days > 30) {
			return fail(400, {
				message: "Expiry must be between 1 and 30 days.",
				unbound: [] as string[],
			});
		}

		const { requests, malformed } = parseRoster(roster);
		if (requests.length === 0) {
			return fail(400, {
				message: "Nobody to invite. One person per line.",
				unbound: [] as string[],
			});
		}

		const client = new AuthentikClient({ baseUrl: url, token });
		const [applications, bindings, users, flows] = await Promise.all([
			client.applications(),
			client.bindings(),
			client.users(),
			client.enrollmentFlow(FLOW_SLUG),
		]);

		const gate = onboardingGate(unboundApplications(applications, bindings));
		if (gate.blocked) {
			return fail(409, {
				message: `Blocked: ${gate.reason} Bind them before inviting anyone.`,
				unbound: gate.unboundApplications,
			});
		}

		if (!flows) {
			return fail(500, {
				message: `Enrollment flow ${FLOW_SLUG} not found in Authentik.`,
				unbound: [] as string[],
			});
		}

		const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
		const outcome = await mintInvitations(requests, {
			writer: new AuthentikWriter({ baseUrl: url, token }),
			flowPk: flows.pk,
			flowSlug: FLOW_SLUG,
			publicBaseUrl: publicUrl,
			expiresAt,
			stamp: String(Date.now()).slice(-6),
			singleUse,
			existingUsernames: new Set(
				users.filter((u) => u.type === "internal").map((u) => u.username.toLowerCase()),
			),
		});

		return {
			created: outcome.created,
			failed: [
				...outcome.failed,
				...malformed.map((line) => ({ username: line, reason: "could not read this line" })),
			],
			expires: expiresAt.toISOString(),
		};
	},
};
