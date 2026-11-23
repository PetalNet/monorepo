import { SERP_FETCH_URL, SERP_INTERNAL_KEY } from "$app/env/private";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	if (!SERP_FETCH_URL || !SERP_INTERNAL_KEY) {
		return new Response(null, { status: 503 });
	}

	try {
		const response = await fetch(new URL("/egress", SERP_FETCH_URL), {
			headers: { Accept: "application/json", "X-Internal-Key": SERP_INTERNAL_KEY },
			signal: AbortSignal.timeout(12_000),
		});

		return new Response(await response.text(), {
			status: response.status,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": response.ok ? "public, max-age=60" : "no-store",
			},
		});
	} catch {
		return new Response(null, { status: 502 });
	}
};
