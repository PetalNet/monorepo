import { prisma } from "$lib/server/prisma";
import { getClientCredentialsToken, searchTracks } from "$lib/server/spotify";
import { json, error } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
	const query = url.searchParams.get("q");
	const eventCode = url.searchParams.get("eventCode");

	if (!query) {
		throw error(400, "Missing query parameter");
	}

	if (eventCode) {
		const event = await prisma.event.findUnique({
			where: { publicCode: eventCode },
			select: { id: true },
		});

		if (!event) {
			throw error(404, "Event not found");
		}
	} else if (!locals.user) {
		throw error(401, "Unauthorized");
	}

	try {
		const results = await searchTracks(query, await getClientCredentialsToken());

		return json(results);
	} catch (err) {
		console.error("Search error:", err);

		throw error(500, "Failed to search Spotify");
	}
};
