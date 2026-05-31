import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const query = url.searchParams.get('q');

	if (!query) {
		return json({ error: 'Query parameter "q" is required' }, { status: 400 });
	}

	try {
		// Use Nominatim for geocoding
		const response = await fetch(
			`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&countrycodes=us`,
			{
				headers: {
					'User-Agent': 'CollegeMapApp/1.0'
				}
			}
		);

		if (!response.ok) {
			return json({ error: 'Geocoding service unavailable' }, { status: 502 });
		}

		const results = await response.json();

		const formatted = results.map(
			(r: { display_name: string; lat: string; lon: string }) => ({
				name: r.display_name,
				lat: parseFloat(r.lat),
				lng: parseFloat(r.lon)
			})
		);

		return json(formatted);
	} catch {
		return json({ error: 'Geocoding failed' }, { status: 500 });
	}
};
