import { buildIcs } from "$lib/eventDetails";
import { prisma } from "$lib/server/prisma";
import { error } from "@sveltejs/kit";

export const GET = async ({ params, url }) => {
	const event = await prisma.event.findUnique({
		where: { publicCode: params.code },
		select: { id: true, title: true, date: true, endDate: true, location: true, publicCode: true },
	});

	if (!event) {
		throw error(404, "Event not found");
	}

	const ics = buildIcs({
		uid: `${event.id}@petalboard`,
		title: event.title,
		start: event.date,
		end: event.endDate,
		location: event.location,
		url: new URL(`/event/${event.publicCode}`, url.origin).href,
	});

	return new Response(ics, {
		headers: {
			"Content-Type": "text/calendar; charset=utf-8",
			"Content-Disposition": `attachment; filename="${event.publicCode}.ics"`,
		},
	});
};
