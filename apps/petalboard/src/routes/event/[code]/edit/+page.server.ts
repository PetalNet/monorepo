import { prisma } from "$lib/server/prisma";
import { consumeLink, createSession, setRsvpCookie } from "$lib/server/rsvpAccess";
import { error, fail, redirect } from "@sveltejs/kit";

async function findEvent(code: string) {
	const event = await prisma.event.findUnique({
		where: { publicCode: code },
		select: { id: true, title: true, publicCode: true },
	});

	if (!event) {
		throw error(404, "Event not found");
	}

	return event;
}

// Mail scanners fetch links before the guest clicks them, so GET only renders a confirm button.
export const load = async ({ params, url, setHeaders }) => {
	const event = await findEvent(params.code);

	setHeaders({ "Referrer-Policy": "same-origin", "Cache-Control": "no-store" });

	return {
		event: { title: event.title, publicCode: event.publicCode },
		token: url.searchParams.get("token") ?? "",
	};
};

export const actions = {
	default: async ({ request, params, cookies }) => {
		const event = await findEvent(params.code);
		const token = (await request.formData()).get("token");
		const rsvpId = typeof token === "string" && token ? await consumeLink(token, event.id) : null;

		if (!rsvpId) {
			return fail(400, { expired: true });
		}

		setRsvpCookie(cookies, event.publicCode, await createSession(rsvpId));

		throw redirect(303, `/event/${event.publicCode}?edit=1`);
	},
};
