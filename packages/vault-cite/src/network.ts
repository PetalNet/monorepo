import type { LookupAddress } from "node:dns";
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

import type { Capture, Job } from "./model.ts";
import { PacingDeferred } from "./model.ts";
import { CaptureError, httpUrl } from "./model.ts";
import { diskGuard } from "./store.ts";
import type { Store } from "./store.ts";

// Page assets are capped like a browser's per-host connection pool instead of paced like documents.
const assetsPerHost = 6;
const assetsInFlight = new Map<string, number>();
const robotsChecks = new Map<string, Promise<number>>();
const agent = "VaultCite/0.1 (+https://github.com/PetalNet/monorepo/tree/main/packages/vault-cite)";
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

const lookups = new Map<string, Promise<LookupAddress[]>>();

// Page assets reach a host several at a time, and bursts of concurrent lookups stall on some
// resolvers. Requests share one lookup per host for a minute; a failed lookup is not kept.
function resolveHost(host: string) {
	let pending = lookups.get(host);

	if (!pending) {
		pending = lookup(host, { all: true });
		lookups.set(host, pending);

		pending.then(
			() => setTimeout(() => lookups.delete(host), 60_000).unref(),
			() => lookups.delete(host),
		);
	}

	return pending;
}

async function request(url: string): Promise<Reply> {
	const target = new URL(httpUrl(url));
	const host = target.hostname.replace(/^\[|\]$/g, "");
	const addresses = await resolveHost(host);
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
	readonly interval: number;
	readonly job: Job | undefined;
	constructor(store: Store, transport: Transport = request, interval = 3000, job?: Job) {
		this.job = job;
		this.store = store;
		this.transport = transport;
		this.interval = interval;
	}
	forJob(job: Job) {
		return new Network(this.store, this.transport, this.interval, job);
	}
	private cached(url: string): Reply | undefined {
		if (!this.job) {
			return undefined;
		}

		const row = this.store.db
			.prepare("SELECT metadata,body FROM request_cache WHERE ref=? AND url=?")
			.get(this.job.ref, url);

		if (!row) {
			return undefined;
		}

		const cached = z.object({ metadata: z.string(), body: z.instanceof(Uint8Array) }).parse(row);
		const metadata = z
			.object({
				url: z.string(),
				status: z.number(),
				headers: z.record(z.string(), z.string()),
				fetchedAt: z.string(),
			})
			.parse(JSON.parse(cached.metadata));

		return { ...metadata, body: Buffer.from(cached.body) };
	}
	private checkpoint(reply: Reply) {
		if (!this.job || reply.status < 200 || reply.status >= 400) {
			return;
		}

		const row = this.store.db
			.prepare("SELECT coalesce(sum(length(body)),0) AS bytes FROM request_cache WHERE ref=?")
			.get(this.job.ref);

		if (z.object({ bytes: z.number() }).parse(row).bytes + reply.body.length > 128 * 1024 ** 2) {
			throw new CaptureError("FAILED", "Capture checkpoints exceed 128 MiB limit");
		}

		diskGuard(this.store.root, reply.body.length * 3);
		const { body, ...metadata } = reply;

		metadata.headers = Object.fromEntries(
			Object.entries(reply.headers).filter(
				([key]) => key === "content-type" || key === "content-encoding" || key === "location",
			),
		);

		this.store.db
			.prepare(
				"INSERT OR IGNORE INTO request_cache SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE ref=? AND state='RUNNING' AND lease_until=?)",
			)
			.run(
				this.job.ref,
				reply.url,
				JSON.stringify(metadata),
				body,
				this.job.ref,
				this.job.lease_until,
			);
	}
	private async paced(url: string, delay = this.interval, checkpoint = true, asset = false) {
		const cached = checkpoint ? this.cached(url) : undefined;

		if (cached) {
			return cached;
		}

		diskGuard(this.store.root, maxBytes);
		const host = new URL(url).hostname;
		let reply: Reply;

		if (asset) {
			for (;;) {
				while ((assetsInFlight.get(host) ?? 0) >= assetsPerHost) {
					await sleep(25);
				}

				// Assets skip document pacing, so a host time further out than one paced interval is a
				// server-directed cooldown (429, 503, rate limit). Honor it as documents do.
				const until = this.store.hostNext(host);

				if (until <= Date.now() + delay) {
					break;
				}

				if (until > Date.now() + 30_000) {
					throw new PacingDeferred(until);
				}

				await sleep(until - Date.now());
			}

			assetsInFlight.set(host, (assetsInFlight.get(host) ?? 0) + 1);

			try {
				reply = await this.transport(url);
			} finally {
				const left = (assetsInFlight.get(host) ?? 1) - 1;

				if (left > 0) {
					assetsInFlight.set(host, left);
				} else {
					assetsInFlight.delete(host);
				}
			}
		} else {
			// Per-host pacing alone lets a crawl over many hosts burst; cap the overall request rate too.
			for (;;) {
				const slot = this.store.slot(host, delay, Math.min(this.interval, 400));

				await sleep(Math.max(0, slot.at - Date.now()));

				if (slot.reserved) {
					break;
				}
			}

			reply = await this.transport(url);
		}

		reply.fetchedAt ??= new Date().toISOString();

		if (rateLimited(reply) || reply.status === 503) {
			this.store.cooldown(host, Math.max(30_000, retryDelay(reply)));
		}

		if (checkpoint) {
			this.checkpoint(reply);
		}

		return reply;
	}
	async allowed(url: string) {
		const origin = new URL(httpUrl(url)).origin;

		// Concurrent page assets on a new host wait for one robots fetch instead of each pacing their own.
		for (let pending = robotsChecks.get(origin); pending; pending = robotsChecks.get(origin)) {
			try {
				await pending;
			} catch (error) {
				// A disallow of another URL still cached the policy. Any other failure is the origin's, so
				// waiters share it instead of each fetching robots again.
				const cached = this.store.db
					.prepare("SELECT 1 FROM robots WHERE origin=? AND expires_at>?")
					.get(origin, Date.now());

				if (!cached) {
					throw error;
				}
			}
		}

		const check = this.robots(url, origin);

		robotsChecks.set(origin, check);

		try {
			return await check;
		} finally {
			if (robotsChecks.get(origin) === check) {
				robotsChecks.delete(origin);
			}
		}
	}
	private async robots(url: string, origin: string) {
		let policy: ReturnType<typeof robotsParser> | undefined;
		const stored = this.store.db
			.prepare("SELECT content FROM robots WHERE origin=? AND expires_at>?")
			.get(origin, Date.now());

		if (stored) {
			policy = robotsParser(
				`${origin}/robots.txt`,
				z.object({ content: z.string() }).parse(stored).content,
			);
		}

		if (!policy) {
			let robotsUrl = `${origin}/robots.txt`;
			let response: Reply | undefined;

			for (let hop = 0; hop < 6; hop++) {
				response = await this.paced(robotsUrl, this.interval, false);

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

			// RFC 9309 2.3.1.3: a 4xx robots response is unavailable, so access is allowed. Auth failures and
			// rate limits stay closed. API hosts such as Unpaywall answer every unknown path with 422.
			if (
				response.status >= 400 &&
				response.status < 500 &&
				![401, 403, 429].includes(response.status)
			) {
				policy = robotsParser(`${origin}/robots.txt`, "");
			} else if (response.status === 200) {
				// RFC 9309 2.3.1.1: follow the parseable rules. An HTML page served here, such as an app shell or
				// a soft 404 reached by redirect, is parsed like any body and normally has no rules.
				policy = robotsParser(`${origin}/robots.txt`, decoded(response).toString());
			} else {
				throw new CaptureError(
					!rateLimited(response) && (response.status === 401 || response.status === 403)
						? "INACCESSIBLE"
						: "RETRY",
					`Robots unavailable (HTTP ${String(response.status)})`,
					retryDelay(response),
				);
			}

			const content = response.status === 200 ? decoded(response).toString() : "";

			diskGuard(this.store.root, Buffer.byteLength(content) * 3);

			this.store.db
				.prepare(
					"INSERT INTO robots VALUES(?,?,?) ON CONFLICT(origin) DO UPDATE SET content=excluded.content,expires_at=excluded.expires_at",
				)
				.run(origin, content, Date.now() + 60 * 60_000);
		}

		if (policy.isAllowed(url, agent) === false) {
			throw new CaptureError("INACCESSIBLE", "robots.txt disallows capture");
		}

		return Math.max(this.interval, (policy.getCrawlDelay(agent) ?? 0) * 1000);
	}
	/** An asset is a stylesheet, image or font a page loads; documents and robots files stay paced. */
	async get(url: string, asset = false): Promise<Reply> {
		let current = httpUrl(url);

		for (let hop = 0; hop < 8; hop++) {
			const delay = await this.allowed(current);
			const response = await this.paced(current, delay, true, asset);

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers["location"];

				if (!location) {
					throw new CaptureError("FAILED", "Redirect without location");
				}

				current = httpUrl(new URL(location, current).href);

				continue;
			}

			if (rateLimited(response)) {
				throw new CaptureError(
					"RETRY",
					`Rate limited (HTTP ${String(response.status)})`,
					retryDelay(response),
				);
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

// GitHub signals an exhausted quota with 403 plus rate-limit headers, not only with 429.
function rateLimited(reply: Reply): boolean {
	return (
		reply.status === 429 ||
		(reply.status === 403 &&
			(reply.headers["x-ratelimit-remaining"] === "0" || "retry-after" in reply.headers))
	);
}

function retryDelay(reply: Reply): number {
	const value = reply.headers["retry-after"];

	if (!value) {
		const reset = Number(reply.headers["x-ratelimit-reset"]);

		return Number.isFinite(reset) ? Math.max(0, reset * 1000 - Date.now()) : 0;
	}

	const seconds = Number(value);

	return Math.max(
		0,
		Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(value) || 0) - Date.now(),
	);
}
