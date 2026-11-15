import { handleShareDraft } from "../../../../lib/server/share-draft.js";

// PUBLIC draft slot for one share: /s/<token>/draft. It rides the existing /s/ SSO exemption
// (Traefik router tasks-share and isPublicShare in hooks.server.js). All access control lives in
// share-draft.js; this file only adapts SvelteKit to it.

// Traefik is the only thing that can reach the loopback port, and it appends the real client
// address as the LAST X-Forwarded-For entry. Earlier entries are client-supplied, so ignore them.
function clientIp(request, getClientAddress) {
	const last = (request.headers.get("x-forwarded-for") || "").split(",").pop().trim();

	if (last) {
		return last;
	}

	try {
		return getClientAddress();
	} catch {
		return "unknown";
	}
}

async function handle({ request, params, getClientAddress }) {
	const r = await handleShareDraft({
		request,
		token: params.token,
		ip: clientIp(request, getClientAddress),
	});

	return new Response(r.body, { status: r.status, headers: r.headers });
}

export const GET = handle;
export const PUT = handle;
export const OPTIONS = handle;
