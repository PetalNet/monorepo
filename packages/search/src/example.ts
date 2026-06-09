// Runnable example: register the WEB/SearXNG provider in a ProviderRegistry and
// run a single FEDERATED query through the backend — entirely against a MOCKED
// SearXNG response, so it never touches the network. This is the end-to-end
// "how a host wires it up" demo.
//
// Run it:  node --experimental-strip-types packages/search/src/example.ts
//   (or:   vp run -w @petalnet/search example   once wired to a script)
//
// This module stays free of `@types/node` so the package's runtime-free tsconfig
// is unchanged; the direct-run guard reads `process` off `globalThis` with a
// minimal local shape rather than depending on node's ambient types.

import { search } from "./federate.ts";
import { createWebProvider } from "./providers/web-searxng.ts";
import { ProviderRegistry } from "./registry.ts";

/** A fake SearXNG `/search?format=json` payload, standing in for a live instance. */
const MOCK_SEARXNG = {
	results: [
		{
			url: "https://en.wikipedia.org/wiki/Distributed_search_engine",
			title: "Distributed search engine",
			content: "A distributed search engine spreads the work across many nodes…",
			engine: "wikipedia",
			category: "general",
		},
		{
			url: "https://example.com/news/federated-search",
			title: "Federated search hits the mainstream",
			content: "A roundup of federated-search tooling shipping this quarter.",
			engine: "duckduckgo news",
			category: "news",
			publishedDate: "2026-06-01T00:00:00Z",
		},
		{
			// A duplicate URL (different title) the federation layer should dedupe away.
			url: "https://en.wikipedia.org/wiki/Distributed_search_engine",
			title: "Distributed search engine (dupe)",
			engine: "brave",
			category: "general",
		},
	],
};

/** A fetch that always returns the mock payload, regardless of URL. */
const mockFetch = ((): typeof fetch => {
	return (() =>
		Promise.resolve(
			new Response(JSON.stringify(MOCK_SEARXNG), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		)) as typeof fetch;
})();

/** Wire a registry with the web provider and run one federated query. Returns the response. */
export async function runExample(): ReturnType<typeof search> {
	const registry = new ProviderRegistry().register(
		createWebProvider({
			baseUrl: "https://search.petalcat.dev",
			fetch: mockFetch,
			// Standalone-friendly: degrade to an empty set + "search the web" action on failure.
			graceful: true,
		}),
	);

	return search("distributed search", {
		providers: registry,
		perProviderTimeoutMs: 3000,
		limit: 10,
	});
}

// Minimal local view of the Node process bits we touch — avoids a dependency on
// `@types/node` so the package's runtime-free tsconfig is left untouched.
interface MinimalProcess {
	readonly argv: readonly string[];
	exitCode?: number;
}
const proc = (globalThis as { process?: MinimalProcess }).process;

// When executed directly (not imported), print the federated result.
if (proc && import.meta.url === `file://${proc.argv[1]}`) {
	runExample()
		.then((response) => {
			console.log("providers:", response.providers);
			console.log("errors:", response.errors);
			console.log(
				"actions:",
				response.actions.map((a) => a.title),
			);
			console.log("results:");
			for (const r of response.results) {
				console.log(
					`  [${r.kind}] ${r.title} (${r.url ?? "no-url"}) rank=${r.rankScore.toFixed(3)}`,
				);
			}
			return undefined;
		})
		.catch((err: unknown) => {
			console.error("example failed:", err);
			proc.exitCode = 1;
		});
}
