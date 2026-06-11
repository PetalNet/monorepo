#!/usr/bin/env node
// Clarity MCP — exposes the Clarity / SearXNG metasearch backend (clarity.petalcat.dev) as MCP tools
// (web_search + fetch_url) for use as a search engine inside any MCP client. stdio transport,
// stateless, read-only. No API key (the backend is open behind the Cloudflare edge).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env["CLARITY_BASE_URL"] ?? "https://clarity.petalcat.dev").replace(
	/\/+$/,
	"",
);
const TIMEOUT_MS = Number(process.env["CLARITY_TIMEOUT_MS"] ?? 20_000);
const USER_AGENT = "clarity-mcp/1.0 (+https://clarity.petalcat.dev)";

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
		const body = (await res.text().catch(() => "")).slice(0, 200);
		throw new Error(`Upstream ${String(res.status)} ${res.statusText} from ${url}. ${body}`.trim());
	}
	return res;
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
		return Number.isFinite(code) ? String.fromCodePoint(code) : match;
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
		const data = (await res.json()) as SearxResponse;
		const limit = max_results ?? 10;

		const results = (data.results ?? []).slice(0, limit).map((r) => ({
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
			unresponsive_engines: (data.unresponsive_engines ?? []).flat().map(String),
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
		const res = await httpGet(url, "text/html,application/xhtml+xml");
		const contentType = res.headers.get("content-type") ?? "";
		const raw = await res.text();
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
