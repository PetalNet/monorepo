import { getRequestEvent } from "$app/server";
import { publicConfig } from "$lib/config";
import { searchMockPalette, type PaletteSearchResponse } from "$lib/data/palette";
import { Effect, Schema } from "effect";
import { Query } from "svelte-effect-runtime";

const input = Schema.Struct({
	query: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});

/**
 * Server-side RPC boundary for the global launcher. The browser never hand-rolls a console-api
 * request; SvelteKit owns transport, validation, serialization, and cancellation semantics.
 */
export const searchCommandPalette = Query(input, ({ query: text }) =>
	Effect.promise(async () => {
		if (publicConfig.dataMode === "mock") return searchMockPalette(text);

		const event = getRequestEvent();
		const headers = new Headers({ accept: "application/json", origin: event.url.origin });
		for (const name of ["authorization", "cookie"] as const) {
			const value = event.request.headers.get(name);
			if (value) headers.set(name, value);
		}
		const base = publicConfig.consoleApiBase ?? `${event.url.origin}/api/v1`;
		const response = await event.fetch(
			`${base}/palette/search?q=${encodeURIComponent(text)}&limit=24`,
			{ headers },
		);
		if (!response.ok) throw new Error(`Palette search returned ${String(response.status)}`);
		return (await response.json()) as PaletteSearchResponse;
	}),
);
