import type { RequestEvent } from "@sveltejs/kit";

export const requestEvent = (
	request: Request,
	actor: App.Locals["actor"] = null,
): RequestEvent => ({
	request,
	url: new URL(request.url),
	locals: { actor, session: null, user: null },
	params: {},
	platform: undefined,
	route: { id: null },
	isDataRequest: false,
	isSubRequest: false,
	isRemoteRequest: false,
	getClientAddress: () => "127.0.0.1",
	get cookies(): RequestEvent["cookies"] {
		throw new Error("This request fixture does not implement SvelteKit cookies");
	},
	get tracing(): RequestEvent["tracing"] {
		throw new Error("This request fixture does not implement SvelteKit tracing");
	},
	fetch: () => {
		throw new Error("This request fixture does not implement SvelteKit fetch");
	},
	setHeaders: () => {
		throw new Error("This request fixture does not implement SvelteKit response headers");
	},
});
