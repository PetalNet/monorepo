# @petalnet/clarity-mcp

An MCP (Model Context Protocol) server that exposes the **Clarity** metasearch backend
([clarity.petalcat.dev](https://clarity.petalcat.dev), a SearXNG instance) as a web search engine for
Claude Code or any MCP client. Read-only, no API key.

## Tools

| Tool         | Purpose                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web_search` | Search the web (aggregates Google, DuckDuckGo, Startpage, …). Args: `query` (required), `category`, `time_range` (day/week/month/year), `language`, `page`, `max_results`. Returns ranked `{title, url, content, engine, category, score, publishedDate}` plus `suggestions`/`corrections`/`unresponsive_engines`. |
| `fetch_url`  | Fetch a page and return its readable text (HTML stripped). Args: `url` (required), `max_chars`. Use after `web_search` to read a result in full.                                                                                                                                                                   |

## Build & run

```bash
pnpm --filter @petalnet/clarity-mcp build   # tsc -b -> dist/
pnpm --filter @petalnet/clarity-mcp start   # run the stdio server
```

Test interactively with the MCP Inspector:

```bash
pnpm dlx @modelcontextprotocol/inspector node apps/clarity-mcp/dist/index.js
```

## Register in an MCP client

After `build`, point the client at the built entry (stdio):

```json
{
	"mcpServers": {
		"clarity-search": {
			"command": "node",
			"args": ["apps/clarity-mcp/dist/index.js"]
		}
	}
}
```

The tools appear as `mcp__clarity-search__web_search` and `mcp__clarity-search__fetch_url`.

## Config (env)

| Var                  | Default                        | Notes                                                                                     |
| -------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `CLARITY_BASE_URL`   | `https://clarity.petalcat.dev` | Point at any SearXNG instance with the JSON format enabled.                               |
| `CLARITY_TIMEOUT_MS` | `20000`                        | Per-request timeout. The origin occasionally cold-starts (502) — the client retries once. |

## Notes

- Backend is SearXNG; the JSON API is `GET /search?q=…&format=json` (+ `categories`, `time_range`,
  `language`, `pageno`). Categories come from `GET /config`.
- `stdout` is the JSON-RPC channel; the server logs only to `stderr`.
