#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CFG_PATH = path.join(homedir(), ".config/claude-matrix-channel/usage.toml");
const OUT_PATH =
	process.env.CLAUDE_USAGE_RAW_OUT ?? "/home/docker/.claude/shared/janet-usage-raw.json";

function readCfg() {
	const text = readFileSync(CFG_PATH, "utf8");
	const get = (key: string) => {
		const m = new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m").exec(text);

		return m ? m[1] : null;
	};

	return { session_key: get("session_key"), org_id: get("org_id") };
}

async function main() {
	const { session_key, org_id } = readCfg();

	if (!session_key || !org_id) {
		console.error("usage-fetch: missing session_key or org_id in usage.toml");
		process.exit(2);
	}

	const url = `https://claude.ai/api/organizations/${org_id}/usage`;
	const headers = {
		Accept: "application/json",
		"Accept-Language": "en-US,en;q=0.9",
		Cookie: `sessionKey=${session_key}`,
		Referer: "https://claude.ai/settings/usage",
		Origin: "https://claude.ai",
		"Sec-Fetch-Dest": "empty",
		"Sec-Fetch-Mode": "cors",
		"Sec-Fetch-Site": "same-origin",
		"User-Agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:149.0) Gecko/20100101 Firefox/149.0",
	};

	const res = await fetch(url, { headers });

	if (!res.ok) {
		console.error(`usage-fetch: HTTP ${String(res.status)}`);
		process.exit(2);
	}

	const body: unknown = await res.json();

	writeFileSync(OUT_PATH, JSON.stringify(body, null, 2));
	process.stdout.write(JSON.stringify(body));
}

try {
	await main();
} catch (err) {
	console.error(`usage-fetch: ${err instanceof Error ? err.message : "request failed"}`);
	process.exit(2);
}
