import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import {
	buildConsoleApi,
	type ConsoleApi,
	type ConsoleApiOptions,
} from "../../src/lib/server/api/console-api.ts";
import { attachBusConnection, type BusSocket } from "../../src/lib/server/domain/bus/connection.ts";
import { inertExceptionMonitor } from "../../src/lib/server/domain/observability.ts";
import type { Services } from "../../src/lib/server/domain/substrate.ts";

export interface InjectOptions {
	readonly method: string;
	readonly url: string;
	readonly headers?: Record<string, string>;
	readonly payload?: unknown;
}

export interface InjectResponse {
	readonly statusCode: number;
	readonly body: string;
	readonly headers: Record<string, string>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- inject parity with the old light-my-request json()
	json<T = any>(): T;
}

/** Ws-like client seam over the in-memory bus bridge (headers can ride, unlike WHATWG sockets). */
export interface InjectedSocket {
	on(event: "message", listener: (data: string) => void): void;
	send(data: string): void;
	close(): void;
	terminate(): void;
}

export interface TestSurface {
	/** Drives the console API core directly — the same handler the SvelteKit catch-all delegates to. */
	inject(options: InjectOptions): Promise<InjectResponse>;
	/**
	 * Attaches a bus connection exactly as the WebSocket surface does (same attachBusConnection, same
	 * principal chain), bridged in memory so test headers can authenticate the socket.
	 */
	injectWS(path: string, options?: { headers?: Record<string, string> }): Promise<InjectedSocket>;
	/** Http origin of the listening surface, for streaming/fetch-driven tests. */
	readonly origin: string;
	/** Live bus socket bookkeeping shared with /api/v1/health. */
	busCounters(): { clients: number; subscriptions: number };
	close(): Promise<void>;
}

const toWebHeaders = (headers: IncomingMessage["headers"]): Headers =>
	new Headers(
		Object.entries(headers).flatMap(([name, value]) =>
			typeof value === "string"
				? [[name, value] as [string, string]]
				: (value ?? []).map((item) => [name, item] as [string, string]),
		),
	);

const toRequest = (request: IncomingMessage): Request => {
	const method = request.method ?? "GET";
	const body =
		method === "GET" || method === "HEAD"
			? null
			: (Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>);
	return new Request(`http://${request.headers.host ?? "console.local"}${request.url ?? "/"}`, {
		method,
		headers: toWebHeaders(request.headers),
		...(body ? { body, duplex: "half" } : {}),
	} as RequestInit);
};

const writeResponse = async (res: ServerResponse, response: Response): Promise<void> => {
	res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
	if (!response.body) {
		res.end();
		return;
	}
	const reader = response.body.getReader();
	res.once("close", () => void reader.cancel().catch(() => undefined));
	const pump = async (): Promise<void> => {
		const { done, value } = await reader.read();
		if (done) return;
		if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve));
		return pump();
	};
	await pump().catch(() => {
		/* client went away mid-stream; cancel already scheduled */
	});
	res.end();
};

/** Boots the folded SvelteKit-era console surface for tests: HTTP core + bus WebSocket. */
export async function startTestSurface(
	services: Services,
	options: Partial<ConsoleApiOptions> = {},
): Promise<TestSurface> {
	const api: ConsoleApi = buildConsoleApi(services, { devAuth: true, ...options });
	const monitor = options.monitor ?? inertExceptionMonitor;
	const server: Server = createServer((request, response) => {
		void (async () => {
			const handled = await api.fetch(toRequest(request));
			await writeResponse(
				response,
				handled ??
					Response.json(
						{ error: { code: "not_found", message: "route not found", retryable: false } },
						{ status: 404 },
					),
			);
		})().catch(() => {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
	const openSockets = new Set<() => void>();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test surface did not bind");
	const origin = `http://127.0.0.1:${String(address.port)}`;

	return {
		origin,
		busCounters: () => api.busCounters,
		async inject({ method, url, headers = {}, payload }) {
			const requestHeaders = new Headers(headers);
			let body: string | undefined;
			if (payload !== undefined) {
				body = typeof payload === "string" ? payload : JSON.stringify(payload);
				if (!requestHeaders.has("content-type"))
					requestHeaders.set("content-type", "application/json");
			}
			const response = await api.fetch(
				new Request(`http://console.local${url}`, {
					method,
					headers: requestHeaders,
					...(body === undefined ? {} : { body }),
				}),
			);
			if (!response) throw new Error(`route ${url} is outside the console API surface`);
			const text = await response.text();
			return {
				statusCode: response.status,
				body: text,
				headers: Object.fromEntries(response.headers.entries()),
				json: <T>() => JSON.parse(text) as T,
			};
		},
		injectWS(path, wsOptions = {}) {
			if (path !== "/api/v1/bus/ws") return Promise.reject(new Error(`no websocket at ${path}`));
			const headers = new Headers(wsOptions.headers ?? {});
			const clientMessage: ((data: string) => void)[] = [];
			let open = true;
			let serverMessage: ((data: string | Uint8Array) => void) | undefined;
			let serverClose: (() => void) | undefined;
			const shutdown = (): void => {
				if (!open) return;
				open = false;
				openSockets.delete(shutdown);
				serverClose?.();
			};
			openSockets.add(shutdown);
			const busSocket: BusSocket = {
				send: (text) => {
					if (open) for (const listener of clientMessage) listener(text);
				},
				close: shutdown,
				isOpen: () => open,
				onMessage: (handler) => {
					serverMessage = handler;
				},
				onClose: (handler) => {
					serverClose = handler;
				},
			};
			attachBusConnection(busSocket, {
				services,
				monitor,
				resolvePrincipal: () => api.resolvePrincipal(headers, "console.local"),
				refreshable: Boolean(
					headers.get("authorization")?.startsWith("Bearer ") || options.betterAuth,
				),
				counters: api.busCounters,
			});
			return Promise.resolve({
				on(event, listener) {
					if (event === "message") clientMessage.push(listener);
				},
				send(data) {
					serverMessage?.(data);
				},
				close: shutdown,
				terminate: shutdown,
			});
		},
		async close() {
			for (const shutdown of openSockets) shutdown();
			api.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
