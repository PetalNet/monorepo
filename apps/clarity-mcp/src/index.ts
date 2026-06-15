#!/usr/bin/env node
import { promises as dns } from "node:dns";

// Clarity MCP — exposes the Clarity / SearXNG metasearch backend (clarity.petalcat.dev) as MCP tools
// (web_search + fetch_url) for use as a search engine inside any MCP client. stdio transport,
// stateless, read-only. No API key (the backend is open behind the Cloudflare edge).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// The two loops below are inherently sequential: redirect following (each hop depends on
// validating the previous Location) and streaming-body reads (chunks must be consumed in
// order). Promise.all would be incorrect, not faster — so the await-in-loop rule is disabled.
// oxlint-disable no-await-in-loop

// Prefer the internal SearXNG origin here when available; the public Cloudflare edge may 403 this
// service's non-browser User-Agent.
const BASE_URL = (process.env["CLARITY_BASE_URL"] ?? "https://clarity.petalcat.dev").replace(
	/\/+$/,
	"",
);
const TIMEOUT_MS = Number(process.env["CLARITY_TIMEOUT_MS"] ?? 20_000);
const USER_AGENT = "clarity-mcp/1.0 (+https://clarity.petalcat.dev)";
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

// Shape of the SearXNG JSON response (only the fields we surface).
interface SearxResult {
	url?: string;
	title?: string;
	content?: string;
	engine?: string;
	category?: string;
	score?: number;
	publishedDate?: string | null;
}
interface SearxResponse {
	query?: string;
	results?: SearxResult[];
	suggestions?: string[];
	corrections?: string[];
	unresponsive_engines?: unknown[];
}

function isBlockedIpv4(ip: string): boolean {
	const parts = ip.split(".").map(Number);
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return false;
	}
	const first = parts[0];
	const second = parts[1];
	if (first === undefined || second === undefined) return false;
	return (
		first === 127 ||
		first === 10 ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		(first === 169 && second === 254) ||
		(first === 100 && second >= 64 && second <= 127) ||
		first === 0
	);
}

function isBlockedAddress(ip: string): boolean {
	const normalized = ip.toLowerCase().split("%", 1)[0] ?? "";
	if (isBlockedIpv4(normalized)) return true;

	const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized)?.[1];
	if (mappedIpv4 !== undefined) return isBlockedIpv4(mappedIpv4);
	const mappedHextets = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
	if (mappedHextets !== null) {
		const high = Number.parseInt(mappedHextets[1] ?? "", 16);
		const low = Number.parseInt(mappedHextets[2] ?? "", 16);
		if (Number.isFinite(high) && Number.isFinite(low)) {
			return isBlockedIpv4(
				`${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`,
			);
		}
	}

	if (normalized === "::" || normalized === "::1") return true;
	const firstHextetText = normalized.split(":", 1)[0];
	if (firstHextetText === undefined || firstHextetText === "") return false;
	const firstHextet = Number.parseInt(firstHextetText, 16);
	if (!Number.isFinite(firstHextet)) return false;
	return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80;
}

async function validateFetchUrl(value: string | URL): Promise<URL> {
	const parsed = value instanceof URL ? value : new URL(value);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`unsupported URL protocol: ${parsed.protocol}`);
	}
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
	const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
	for (const { address } of addresses) {
		if (isBlockedAddress(address)) {
			throw new Error(`refusing to fetch private/internal address (${hostname} -> ${address})`);
		}
	}
	return parsed;
}

async function readResponseText(res: Response, controller?: AbortController): Promise<string> {
	assertResponseSize(res, controller);
	if (res.body === null) return "";

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let bytesRead = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		bytesRead += value.byteLength;
		if (bytesRead > MAX_RESPONSE_BYTES) {
			controller?.abort();
			await reader.cancel().catch(() => undefined);
			throw new Error(`response too large (limit: ${String(MAX_RESPONSE_BYTES)} bytes)`);
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

function assertResponseSize(res: Response, controller?: AbortController): void {
	const contentLength = res.headers.get("content-length");
	if (contentLength !== null) {
		const declaredBytes = Number(contentLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) {
			controller?.abort();
			throw new Error(`response too large (limit: ${String(MAX_RESPONSE_BYTES)} bytes)`);
		}
	}
}

/** One fetch with an abort timeout. */
async function fetchOnce(url: string, accept: string): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, TIMEOUT_MS);
	try {
		return await fetch(url, {
			signal: controller.signal,
			headers: { Accept: accept, "User-Agent": USER_AGENT },
		});
	} finally {
		clearTimeout(timer);
	}
}

/** GET with actionable errors. The Clarity origin occasionally 502s (cold backend) — retry once. */
async function httpGet(url: string, accept = "application/json"): Promise<Response> {
	const withRetry = async (): Promise<Response> => {
		try {
			const first = await fetchOnce(url, accept);
			return first.status === 502 ? await fetchOnce(url, accept) : first; // transient cold-origin
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error(
					`Request to ${url} timed out after ${String(TIMEOUT_MS)}ms. The Clarity backend may be cold — try again.`,
					{ cause: err },
				);
			}
			try {
				return await fetchOnce(url, accept); // one retry on network error
			} catch (retryErr) {
				throw new Error(
					`Network error reaching ${url}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
					{ cause: retryErr },
				);
			}
		}
	};

	const res = await withRetry();
	if (!res.ok) {
		const body = (await readResponseText(res).catch(() => "")).slice(0, 200);
		throw new Error(`Upstream ${String(res.status)} ${res.statusText} from ${url}. ${body}`.trim());
	}
	return res;
}

function isRedirect(res: Response): boolean {
	return res.status >= 300 && res.status < 400;
}

function isTextualContentType(contentType: string): boolean {
	const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return (
		mediaType.startsWith("text/") ||
		mediaType === "application/xml" ||
		mediaType === "application/xhtml+xml" ||
		mediaType === "application/json" ||
		mediaType === "application/javascript" ||
		mediaType.endsWith("+xml") ||
		mediaType.endsWith("+json")
	);
}

async function fetchUrlText(url: string): Promise<{ contentType: string; raw: string }> {
	let currentUrl = await validateFetchUrl(url);
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, TIMEOUT_MS);

	try {
		for (let redirects = 0; ; redirects += 1) {
			const res = await fetch(currentUrl, {
				signal: controller.signal,
				redirect: "manual",
				headers: {
					Accept: "text/html,application/xhtml+xml",
					"User-Agent": USER_AGENT,
				},
			});
			if (isRedirect(res)) {
				const location = res.headers.get("location");
				if (location !== null) {
					if (redirects >= MAX_REDIRECTS) {
						await res.body?.cancel().catch(() => undefined);
						throw new Error(`too many redirects (maximum: ${String(MAX_REDIRECTS)})`);
					}
					const nextUrl = new URL(location, currentUrl);
					await res.body?.cancel().catch(() => undefined);
					currentUrl = await validateFetchUrl(nextUrl);
					continue;
				}
			}
			if (!res.ok) {
				const body = (await readResponseText(res, controller)).slice(0, 200);
				throw new Error(
					`Upstream ${String(res.status)} ${res.statusText} from ${currentUrl.toString()}. ${body}`.trim(),
				);
			}

			const contentType = res.headers.get("content-type") ?? "";
			assertResponseSize(res, controller);
			if (!isTextualContentType(contentType)) {
				await res.body?.cancel().catch(() => undefined);
				return {
					contentType,
					raw: `cannot extract text from content-type: ${contentType || "(missing)"}`,
				};
			}
			return { contentType, raw: await readResponseText(res, controller) };
		}
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(
				`Request to ${currentUrl.toString()} timed out after ${String(TIMEOUT_MS)}ms.`,
				{
					cause: err,
				},
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

const HTML_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
	"&#39;": "'",
	"&nbsp;": " ",
};

/** Decode HTML entities in a single pass (each match resolved once → no double-unescaping). */
function decodeEntities(input: string): string {
	return input.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match) => {
		const named = HTML_ENTITIES[match.toLowerCase()];
		if (named !== undefined) return named;
		const isHex = match.startsWith("&#x") || match.startsWith("&#X");
		const code = Number.parseInt(match.slice(isHex ? 3 : 2, -1), isHex ? 16 : 10);
		return Number.isFinite(code) &&
			code >= 0 &&
			code <= 0x10ffff &&
			(code < 0xd800 || code > 0xdfff)
			? String.fromCodePoint(code)
			: match;
	});
}

const DROP_ELEMENTS = ["script", "style", "noscript"];
const TAG_BOUNDARY = new Set([">", "/", " ", "\t", "\n", "\r", "\f"]);

/**
 * Extract readable text from HTML with a single linear scan — no tag-matching regex (which is
 * unreliable for sanitisation). Drops comments and the contents of script/style/noscript, emits the
 * text between tags, then decodes entities once.
 */
function htmlToText(html: string): string {
	const lower = html.toLowerCase();
	const n = html.length;
	let out = "";
	let i = 0;
	while (i < n) {
		const lt = html.indexOf("<", i);
		if (lt === -1) {
			out += html.slice(i);
			break;
		}
		out += html.slice(i, lt);

		if (lower.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			i = end === -1 ? n : end + 3;
			continue;
		}

		const dropped = DROP_ELEMENTS.find((tag) => {
			if (!lower.startsWith(`<${tag}`, lt)) return false;
			const after = lower[lt + tag.length + 1];
			return after === undefined || TAG_BOUNDARY.has(after);
		});
		if (dropped !== undefined) {
			const close = lower.indexOf(`</${dropped}`, lt);
			const gt = close === -1 ? -1 : html.indexOf(">", close);
			i = gt === -1 ? n : gt + 1;
			continue;
		}

		const afterLt = html[lt + 1];
		if (afterLt === undefined || !/[A-Za-z/!?]/.test(afterLt)) {
			out += "<";
			i = lt + 1;
			continue;
		}

		// Generic tag: skip to its closing '>'.
		const gt = html.indexOf(">", lt);
		i = gt === -1 ? n : gt + 1;
	}
	return decodeEntities(out)
		.replace(/[^\S\n]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const server = new McpServer({ name: "clarity-search", version: "1.0.0" });

const resultShape = {
	title: z.string(),
	url: z.string(),
	content: z.string(),
	engine: z.string(),
	category: z.string(),
	score: z.number(),
	publishedDate: z.string().nullable(),
};

server.registerTool(
	"web_search",
	{
		title: "Web search (Clarity/SearXNG)",
		description:
			"Search the web via the Clarity metasearch backend (aggregates Google, DuckDuckGo, Startpage, " +
			"etc.). Returns ranked results with title, URL, snippet, source engine and score. Use for general " +
			"research, docs lookup, news, etc. Pair with fetch_url to read a result in full.",
		inputSchema: {
			query: z.string().min(1).describe("The search query."),
			category: z
				.string()
				.optional()
				.describe(
					'Result category (default: general). e.g. "news", "it", "science", "videos", "images", "files".',
				),
			time_range: z
				.enum(["day", "week", "month", "year"])
				.optional()
				.describe("Restrict to results from the last day/week/month/year."),
			language: z.string().optional().describe('Language/locale code, e.g. "en" or "en-US".'),
			page: z.number().int().min(1).max(20).optional().describe("1-based result page (default 1)."),
			max_results: z
				.number()
				.int()
				.min(1)
				.max(50)
				.optional()
				.describe("Trim to the top N results to keep responses concise (default 10)."),
		},
		outputSchema: {
			query: z.string(),
			results: z.array(z.object(resultShape)),
			suggestions: z.array(z.string()),
			corrections: z.array(z.string()),
			unresponsive_engines: z.array(z.string()),
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
	},
	async ({ query, category, time_range, language, page, max_results }) => {
		const params = new URLSearchParams({ q: query, format: "json" });
		if (category) params.set("categories", category);
		if (time_range) params.set("time_range", time_range);
		if (language) params.set("language", language);
		if (page) params.set("pageno", String(page));

		const res = await httpGet(`${BASE_URL}/search?${params.toString()}`);
		const body = await res.text();
		let data: SearxResponse;
		try {
			data = JSON.parse(body) as SearxResponse;
		} catch (err) {
			throw new Error(`Invalid JSON from Clarity backend: ${body.slice(0, 200)}`, { cause: err });
		}
		const limit = max_results ?? 10;

		const results = (data.results ?? [])
			.filter((result): result is SearxResult => typeof result === "object" && result !== null)
			.slice(0, limit)
			.map((r) => ({
				title: String(r.title ?? ""),
				url: String(r.url ?? ""),
				content: String(r.content ?? ""),
				engine: String(r.engine ?? ""),
				category: String(r.category ?? ""),
				score: Number(r.score ?? 0),
				publishedDate: r.publishedDate ?? null,
			}));
		const structured = {
			query: String(data.query ?? query),
			results,
			suggestions: (data.suggestions ?? []).map(String),
			corrections: (data.corrections ?? []).map(String),
			unresponsive_engines: (data.unresponsive_engines ?? []).map((entry) => {
				if (Array.isArray(entry)) return entry.map(String).join(": ");
				if (typeof entry === "object" && entry !== null) {
					const record = entry as Record<string, unknown>;
					const name = record["name"] ?? record["engine"];
					const error = record["error"] ?? record["reason"];
					return [name, error]
						.filter((part) => part !== undefined && part !== null)
						.map(String)
						.join(": ");
				}
				return String(entry);
			}),
		};

		const text =
			results.length > 0
				? results
						.map(
							(r, i) =>
								`${String(i + 1)}. ${r.title}\n   ${r.url}\n   ${r.content}${r.engine ? `  [${r.engine}]` : ""}`,
						)
						.join("\n\n")
				: `No results for "${query}".${
						structured.suggestions.length > 0
							? ` Suggestions: ${structured.suggestions.join(", ")}`
							: ""
					}`;

		return { content: [{ type: "text" as const, text }], structuredContent: structured };
	},
);

server.registerTool(
	"fetch_url",
	{
		title: "Fetch a URL as text",
		description:
			"Fetch a web page and return its readable text (HTML tags/scripts/styles stripped). Use after " +
			"web_search to read a result in full. Returns plain text truncated to a character budget.",
		inputSchema: {
			url: z.string().url().describe("The absolute URL to fetch (http/https)."),
			max_chars: z
				.number()
				.int()
				.min(500)
				.max(100_000)
				.optional()
				.describe("Max characters of extracted text to return (default 8000)."),
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
	},
	async ({ url, max_chars }) => {
		const { contentType, raw } = await fetchUrlText(url);
		const isHtml = contentType.includes("html") || /<html[\s>]/i.test(raw);
		const text = isHtml ? htmlToText(raw) : raw;
		const limit = max_chars ?? 8000;
		const truncated = text.length > limit;
		const out =
			text.slice(0, limit) +
			(truncated ? `\n\n…[truncated, ${String(text.length)} chars total]` : "");
		return { content: [{ type: "text" as const, text: out }] };
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is safe for logs (stdout is the JSON-RPC channel).
console.error(`clarity-search MCP ready (backend: ${BASE_URL})`);
