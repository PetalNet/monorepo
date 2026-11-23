import { SERP_FETCH_URL, SERP_INTERNAL_KEY } from "$app/env/private";

import type { RequestHandler } from "./$types";

interface PublicEgress {
	country_code: string;
	country_name: string;
	rotates_in: string | null;
}

let cached: { payload: PublicEgress; expires: number } | undefined;
let pending: Promise<PublicEgress | undefined> | undefined;

async function loadEgress(): Promise<PublicEgress | undefined> {
	try {
		const response = await fetch(new URL("/egress", SERP_FETCH_URL), {
			headers: { Accept: "application/json", "X-Internal-Key": SERP_INTERNAL_KEY },
			signal: AbortSignal.timeout(12_000),
		});

		if (!response.ok) {
			return;
		}

		const body: unknown = await response.json();

		if (
			!body ||
			typeof body !== "object" ||
			!("country_code" in body) ||
			typeof body.country_code !== "string" ||
			!("country_name" in body) ||
			typeof body.country_name !== "string" ||
			!("rotates_in" in body) ||
			(body.rotates_in !== null && typeof body.rotates_in !== "string")
		) {
			return;
		}

		const { country_code, country_name, rotates_in } = body;
		const payload = { country_code, country_name, rotates_in };

		cached = { payload, expires: Date.now() + 60_000 };

		return payload;
	} catch {
		/* An unavailable upstream yields an empty 502. */
	}
}

export const GET: RequestHandler = async () => {
	if (!SERP_FETCH_URL || !SERP_INTERNAL_KEY) {
		return new Response(null, { status: 503 });
	}

	if (cached && cached.expires > Date.now()) {
		return Response.json(cached.payload, { headers: { "Cache-Control": "public, max-age=60" } });
	}

	pending ??= loadEgress().finally(() => {
		pending = undefined;
	});

	const payload = await pending;

	return payload
		? Response.json(payload, { headers: { "Cache-Control": "public, max-age=60" } })
		: new Response(null, { status: 502 });
};
