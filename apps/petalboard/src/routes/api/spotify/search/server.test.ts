import { describe, expect, it, vi } from "vitest";

const { findEvent, findUser } = vi.hoisted(() => ({ findEvent: vi.fn(), findUser: vi.fn() }));

vi.mock("$env/dynamic/private", () => ({
	env: { SPOTIFY_CLIENT_ID: "client-id", SPOTIFY_CLIENT_SECRET: "client-secret" },
}));

vi.mock("$lib/server/prisma", () => ({
	prisma: { event: { findUnique: findEvent }, user: { findUnique: findUser } },
}));

import { GET } from "./+server";

function request(requestUrl: string) {
	const url = new URL(requestUrl);

	return GET({
		cookies: { get: vi.fn(), getAll: vi.fn(), set: vi.fn(), delete: vi.fn(), serialize: vi.fn() },
		fetch: globalThis.fetch,
		getClientAddress: () => "127.0.0.1",
		locals: { user: null },
		params: {},
		platform: undefined,
		request: new Request(url),
		route: { id: "/api/spotify/search" },
		setHeaders: vi.fn(),
		url,
		isDataRequest: false,
		isSubRequest: false,
		tracing: Object.create(null),
		isRemoteRequest: false,
	} satisfies Parameters<typeof GET>[0]);
}

describe("Spotify search", () => {
	it("searches with app credentials when the event host has no Spotify tokens", async () => {
		findEvent.mockResolvedValue({ id: "event-1" });
		findUser.mockResolvedValue({ spotifyAccessToken: null, spotifyRefreshToken: null });

		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(Response.json({ access_token: "app-token", expires_in: 3600 }))
			.mockResolvedValueOnce(Response.json({ tracks: { items: [{ id: "track-1" }] } }));

		vi.stubGlobal("fetch", fetch);

		const response = await request(
			"https://board.example.test/api/spotify/search?q=Satellite&eventCode=party",
		);

		expect(await response.json()).toEqual({ tracks: { items: [{ id: "track-1" }] } });

		expect(findEvent).toHaveBeenCalledWith({
			where: { publicCode: "party" },
			select: { id: true },
		});

		expect(findUser).not.toHaveBeenCalled();

		expect(fetch).toHaveBeenNthCalledWith(
			1,
			"https://accounts.spotify.com/api/token",
			expect.objectContaining({ method: "POST" }),
		);

		expect(fetch).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("https://api.spotify.com/v1/search?"),
			expect.objectContaining({ headers: { Authorization: "Bearer app-token" } }),
		);
	});

	it("returns 404 for an unknown event", async () => {
		findEvent.mockResolvedValue(null);

		await expect(
			request("https://board.example.test/api/spotify/search?q=Satellite&eventCode=missing"),
		).rejects.toMatchObject({ status: 404 });
	});

	it("requires a user when no event code is supplied", async () => {
		await expect(
			request("https://board.example.test/api/spotify/search?q=Satellite"),
		).rejects.toMatchObject({
			status: 401,
		});
	});
});
