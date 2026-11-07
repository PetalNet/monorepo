import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findEvent, findUser } = vi.hoisted(() => ({ findEvent: vi.fn(), findUser: vi.fn() }));

vi.mock("$env/dynamic/private", () => ({
	env: { SPOTIFY_CLIENT_ID: "client-id", SPOTIFY_CLIENT_SECRET: "client-secret" },
}));

vi.mock("$lib/server/prisma", () => ({
	prisma: { event: { findUnique: findEvent }, user: { findUnique: findUser } },
}));

import { invalidateClientCredentialsToken } from "$lib/server/spotify";
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
	beforeEach(() => {
		findEvent.mockReset();
		findUser.mockReset();
		invalidateClientCredentialsToken();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

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

	it("shares one token request across concurrent cold searches", async () => {
		findEvent.mockResolvedValue({ id: "event-1" });

		let resolveToken: (response: Response) => void = () => {
			throw new Error("Token resolver was not initialized");
		};
		const tokenResponse = new Promise<Response>((resolve) => {
			resolveToken = resolve;
		});
		const fetch = vi.fn<typeof globalThis.fetch>((input) => {
			if (input === "https://accounts.spotify.com/api/token") {
				return tokenResponse;
			}

			return Promise.resolve(Response.json({ tracks: { items: [] } }));
		});

		vi.stubGlobal("fetch", fetch);

		const searches = Array.from({ length: 20 }, () =>
			request("https://board.example.test/api/spotify/search?q=Satellite&eventCode=party"),
		);

		resolveToken(Response.json({ access_token: "app-token", expires_in: 3600 }));
		await Promise.all(searches);

		expect(fetch).toHaveBeenCalledTimes(21);
	});

	it("remints and retries once when the search token is unauthorized", async () => {
		findEvent.mockResolvedValue({ id: "event-1" });
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(Response.json({ access_token: "stale-token", expires_in: 3600 }))
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockResolvedValueOnce(Response.json({ access_token: "fresh-token", expires_in: 3600 }))
			.mockResolvedValueOnce(Response.json({ tracks: { items: [{ id: "track-1" }] } }));

		vi.stubGlobal("fetch", fetch);

		const response = await request(
			"https://board.example.test/api/spotify/search?q=Satellite&eventCode=party",
		);

		expect(await response.json()).toEqual({ tracks: { items: [{ id: "track-1" }] } });
		expect(fetch).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("https://api.spotify.com/v1/search?"),
			expect.objectContaining({ headers: { Authorization: "Bearer stale-token" } }),
		);
		expect(fetch).toHaveBeenNthCalledWith(
			4,
			expect.stringContaining("https://api.spotify.com/v1/search?"),
			expect.objectContaining({ headers: { Authorization: "Bearer fresh-token" } }),
		);
		expect(fetch).toHaveBeenCalledTimes(4);
	});
});
