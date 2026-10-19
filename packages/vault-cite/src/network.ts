import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
/* oxlint-disable eslint/no-await-in-loop -- Sequential processing bounds resource use and preserves pacing, redirect and retry order. */
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

import ipaddr from "ipaddr.js";
import robotsModule from "robots-parser";
import { z } from "zod";

// The package ships CommonJS with an ESM default declaration; validate its callable boundary.
const robotsParser = z
	.custom<
		(
			url: string,
			text: string,
		) => {
			isAllowed: (url: string, agent: string) => boolean | undefined;
			getCrawlDelay: (agent: string) => number | undefined;
		}
	>((value) => typeof value === "function")
	.parse(robotsModule);

import type { Capture } from "./model.ts";
import { CaptureError, httpUrl } from "./model.ts";
import { diskGuard } from "./store.ts";
import type { Store } from "./store.ts";

const agent = "VaultCite/0.1";
const maxBytes = 32 * 1024 ** 2;

export interface Reply {
	fetchedAt?: string;
	requestedUrl?: string;
	url: string;
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}
export type Transport = (url: string) => Promise<Reply> | Reply;

export function original(reply: Reply): Capture["artifacts"][number] {
	return {
		data: reply.body,
		mime: reply.headers["content-type"]?.split(";")[0]?.trim() ?? "application/octet-stream",
		role: "ORIGINAL",
		retrieval: {
			url: reply.requestedUrl ?? reply.url,
			fetched_at: reply.fetchedAt ?? new Date().toISOString(),
			final_url: reply.url,
			http_status: reply.status,
			content_type: reply.headers["content-type"] ?? "",
			content_encoding: reply.headers["content-encoding"] ?? "identity",
		},
	};
}

export function decoded(reply: Reply): Buffer {
	const encoding = reply.headers["content-encoding"]?.toLowerCase() ?? "identity";
	const options = { maxOutputLength: maxBytes };

	switch (encoding) {
		case "identity":
			return reply.body;
		case "gzip":
			return gunzipSync(reply.body, options);
		case "deflate":
			return inflateSync(reply.body, options);
		case "br":
			return brotliDecompressSync(reply.body, options);
		default:
			throw new CaptureError("FAILED", "Unsupported HTTP content encoding");
	}
}

function publicAddress(address: string): boolean {
	try {
		return ipaddr.process(address).range() === "unicast";
	} catch {
		return false;
	}
}

async function request(url: string): Promise<Reply> {
	const target = new URL(httpUrl(url));
	const host = target.hostname.replace(/^\[|\]$/g, "");
	const addresses = await lookup(host, { all: true });
	const first = addresses[0];

	if (!first || addresses.some((entry) => !publicAddress(entry.address))) {
		throw new CaptureError("INACCESSIBLE", "Non-public network destination refused");
	}

	return new Promise((resolve, reject) => {
		// Pin the validated address for this connection; a second DNS lookup could rebind.
		const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(
			target,
			{
				headers: { "user-agent": agent, "accept-encoding": "identity" },
				lookup: (_hostname, options, callback) => {
					if (options.all) {
						callback(null, [first]);

						return;
					}

					callback(null, first.address, first.family);
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;

				response.on("data", (chunk: Buffer) => {
					size += chunk.length;

					if (size > maxBytes) {
						req.destroy(new CaptureError("FAILED", "Response exceeds 32 MiB limit"));
					} else {
						chunks.push(chunk);
					}
				});

				response.on("error", reject);

				response.on("end", () => {
					const headers: Record<string, string> = {};

					for (const [key, value] of Object.entries(response.headers)) {
						if (value !== undefined) {
							headers[key] = Array.isArray(value) ? value.join(", ") : value;
						}
					}

					resolve({ url, status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
				});
			},
		);
		const timeout = setTimeout(
			() => req.destroy(new CaptureError("RETRY", "Request timeout")),
			30_000,
		);

		req.on("close", () => {
			clearTimeout(timeout);
		});

		req.on("error", reject);
		req.end();
	});
}

export class Network {
	readonly store: Store;
	readonly transport: Transport;
	readonly policies = new Map<string, ReturnType<typeof robotsParser>>();
	readonly interval: number;
	constructor(store: Store, transport: Transport = request, interval = 3000) {
		this.store = store;
		this.transport = transport;
		this.interval = interval;
	}
	private async paced(url: string, delay = this.interval) {
		diskGuard(this.store.root, maxBytes);
		const host = new URL(url).hostname;

		const wait = Math.max(0, this.store.slot(host, delay) - Date.now());

		if (wait > 30_000) {
			throw new CaptureError("RETRY", "Domain pacing deferred", wait);
		}

		await sleep(wait);
		const reply = await this.transport(url);

		reply.fetchedAt ??= new Date().toISOString();

		if (reply.status === 429 || reply.status === 503) {
			this.store.slot(host, Math.max(30_000, retryDelay(reply)));
		}

		return reply;
	}
	async allowed(url: string) {
		httpUrl(url);
		const origin = new URL(url).origin;
		let policy = this.policies.get(origin);

		if (!policy) {
			let robotsUrl = `${origin}/robots.txt`;
			let response: Reply | undefined;

			for (let hop = 0; hop < 6; hop++) {
				response = await this.paced(robotsUrl);

				if (response.status < 300 || response.status >= 400) {
					break;
				}

				const location = response.headers["location"];

				if (!location) {
					throw new CaptureError("RETRY", "Robots redirect without location");
				}

				const next = new URL(location, robotsUrl);

				if (next.origin !== origin) {
					throw new CaptureError("INACCESSIBLE", "Cross-origin robots redirect refused");
				}

				robotsUrl = next.href;
			}

			if (!response) {
				throw new CaptureError("RETRY", "Robots unavailable");
			}

			if (response.status === 404 || response.status === 410) {
				policy = robotsParser(`${origin}/robots.txt`, "");
			} else if (
				response.status === 200 &&
				!/<(?:html|!doctype)/i.test(decoded(response).toString())
			) {
				policy = robotsParser(`${origin}/robots.txt`, decoded(response).toString());
			} else {
				throw new CaptureError(
					response.status === 401 || response.status === 403 ? "INACCESSIBLE" : "RETRY",
					`Robots unavailable (HTTP ${String(response.status)})`,
					retryDelay(response),
				);
			}

			this.policies.set(origin, policy);
		}

		if (policy.isAllowed(url, agent) === false) {
			throw new CaptureError("INACCESSIBLE", "robots.txt disallows capture");
		}

		return Math.max(this.interval, (policy.getCrawlDelay(agent) ?? 0) * 1000);
	}
	async get(url: string): Promise<Reply> {
		let current = httpUrl(url);

		for (let hop = 0; hop < 8; hop++) {
			const delay = await this.allowed(current);
			const response = await this.paced(current, delay);

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers["location"];

				if (!location) {
					throw new CaptureError("FAILED", "Redirect without location");
				}

				current = httpUrl(new URL(location, current).href);

				continue;
			}

			if ([401, 402, 403, 451].includes(response.status)) {
				throw new CaptureError(
					"INACCESSIBLE",
					`Access restricted (HTTP ${String(response.status)})`,
				);
			}

			if (response.status === 429 || response.status >= 500) {
				throw new CaptureError(
					"RETRY",
					`Temporary HTTP ${String(response.status)}`,
					retryDelay(response),
				);
			}

			if (response.status !== 200) {
				throw new CaptureError("FAILED", `HTTP ${String(response.status)}`);
			}

			response.requestedUrl = httpUrl(url);

			return response;
		}

		throw new CaptureError("FAILED", "Redirect limit exceeded");
	}
}

function retryDelay(reply: Reply): number {
	const value = reply.headers["retry-after"];

	if (!value) {
		return 0;
	}

	const seconds = Number(value);

	return Math.max(
		0,
		Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(value) || 0) - Date.now(),
	);
}
