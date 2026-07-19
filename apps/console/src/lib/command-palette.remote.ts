import { getRequestEvent, query } from "$app/server";
const env = import.meta.env;
import { searchMockPalette, type PaletteSearchResponse } from "$lib/data/palette";
import { Schema } from "effect";

const input = Schema.Struct({
	query: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});

/**
 * Server-side RPC boundary for the global launcher. The browser never hand-rolls a console-api
 * request; SvelteKit owns transport, validation, serialization, and cancellation semantics.
 */
export const searchCommandPalette = query(
	Schema.toStandardSchemaV1(input),
	async ({ query: text }) => {
		if (env.PUBLIC_CONSOLE_DATA_MODE !== "live") return searchMockPalette(text);

		const event = getRequestEvent();
		const headers = new Headers({ accept: "application/json", origin: event.url.origin });
		for (const name of ["authorization", "cookie"] as const) {
			const value = event.request.headers.get(name);
			if (value) headers.set(name, value);
		}
		const base = env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
		const response = await event.fetch(
			`${base}/palette/search?q=${encodeURIComponent(text)}&limit=24`,
			{ headers },
		);
		if (!response.ok) throw new Error(`Palette search returned ${String(response.status)}`);
		return (await response.json()) as PaletteSearchResponse;
	},
);
