// Humanize a raw tool name for display.
//   mcp__<server>__<tool>  →  "<tool words>"  (underscores → spaces)
//   …single-word tools get a short server hint so they aren't bare, e.g.
//   mcp__tracker__update     → "tracker update"
//   mcp__clarity-search__web_search → "web search"
//   mcp__clarity-search__fetch_url  → "fetch url"
// Plain built-ins (Bash, Edit, Read, Grep, Write, …) pass through unchanged.
export function humanizeTool(name) {
	if (!name) {
		return name;
	}

	if (!name.startsWith("mcp__")) {
		return name;
	}

	const parts = name.slice(5).split("__");
	const server = parts[0] || "";
	const tool = (parts[parts.length - 1] || "").replace(/_/g, " ").trim();

	if (!tool) {
		return name;
	}

	// multi-word tools already read clearly; single-word ones borrow the server for context
	if (server && !tool.includes(" ")) {
		return `${server.replace(/[-_]/g, " ")} ${tool}`;
	}

	return tool;
}
