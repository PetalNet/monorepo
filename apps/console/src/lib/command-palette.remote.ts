import { publicConfig } from "$lib/config";
import { searchMockPalette } from "$lib/data/palette";
import { searchPalette } from "$lib/server/domain/palette/service";
import { currentPrincipal } from "$lib/server/domain/principal";
import { ConsoleDomain } from "$lib/server/domain/service";
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
	Effect.gen(function* () {
		if (publicConfig.dataMode === "mock") return searchMockPalette(text);
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		return yield* searchPalette(services, principal, text, 24);
	}),
);
