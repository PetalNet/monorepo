import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { collegeMetadata } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const GET: RequestHandler = async ({ url }) => {
	const name = url.searchParams.get('name');
	if (!name) {
		return json({ collegeName: '', description: null, thumbnailUrl: null }, { status: 400 });
	}

	// Check cache
	const cached = await db
		.select()
		.from(collegeMetadata)
		.where(eq(collegeMetadata.collegeName, name))
		.get();

	if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
		return json({
			collegeName: cached.collegeName,
			description: cached.description,
			thumbnailUrl: cached.thumbnailUrl
		});
	}

	// Fetch from Wikipedia
	const wikiTitle = name.replace(/ /g, '_');
	let description: string | null = null;
	let thumbnailUrl: string | null = null;

	try {
		const resp = await fetch(
			`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiTitle)}`,
			{
				headers: { 'User-Agent': 'CollegeMap/1.0 (college-map-app)' }
			}
		);

		if (resp.ok) {
			const data = await resp.json();
			description = data.extract ? data.extract.slice(0, 500) : null;
			thumbnailUrl = data.thumbnail?.source ?? null;
		}
	} catch {
		// Wikipedia fetch failed, return null description
	}

	// Upsert cache
	if (cached) {
		await db
			.update(collegeMetadata)
			.set({ description, thumbnailUrl, fetchedAt: new Date() })
			.where(eq(collegeMetadata.collegeName, name));
	} else {
		await db
			.insert(collegeMetadata)
			.values({ collegeName: name, description, thumbnailUrl });
	}

	return json({ collegeName: name, description, thumbnailUrl });
};
