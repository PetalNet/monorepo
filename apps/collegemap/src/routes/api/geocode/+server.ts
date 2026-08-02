import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

/** The fields we read off a Nominatim search hit. */
interface NominatimPlace {
	display_name: string;
	lat: string;
	lon: string;
}

export const GET: RequestHandler = async ({ url }) => {
	const query = url.searchParams.get("q");

	if (!query) {
		return json({ error: 'Query parameter "q" is required' }, { status: 400 });
	}

	try {
		// Use Nominatim for geocoding
		const response = await fetch(
			`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&countrycodes=us`,
			{
				headers: {
					"User-Agent": "CollegeMapApp/1.0",
				},
			},
		);

		if (!response.ok) {
			return json({ error: "Geocoding service unavailable" }, { status: 502 });
		}

		const results = (await response.json()) as NominatimPlace[];

		const formatted = results.map((r) => ({
			name: r.display_name,
			lat: parseFloat(r.lat),
			lng: parseFloat(r.lon),
		}));

		return json(formatted);
	} catch {
		return json({ error: "Geocoding failed" }, { status: 500 });
	}
};
