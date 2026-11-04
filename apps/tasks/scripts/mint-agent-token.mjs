#!/usr/bin/env node
// Mint a bearer token for the agent-API (POST /api/agent/rpc).
//
//   node scripts/mint-agent-token.mjs <agent_name> [--assignee <name>] [--projects <csv>]
//
// Honors TASKS_DB_PATH (host runs MUST set it — gotcha-tasks-db-path). The plaintext
// token is printed ONCE and never stored (only sha256 lands in agent_tokens); revoke
// with revokeAgentToken(<id or agent_name>) from src/lib/server/db.js.
//
// SCOPE IS THE SECURITY: --assignee and/or --projects confine the token to that lane.
// Omitting BOTH mints an UNSCOPED token that can read/act on the whole tracker — the
// script makes you say so out loud before it does.
process.env.TASKS_DB_PATH ||= "/srv/tasks/data/tasks.db";

const argv = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--assignee") flags.assignee = argv[++i];
	else if (argv[i] === "--projects") flags.projects = argv[++i];
	else if (argv[i].startsWith("--")) {
		console.error(`unknown flag: ${argv[i]}`);
		process.exit(1);
	} else positional.push(argv[i]);
}
const agent_name = positional[0];
if (!agent_name) {
	console.error(
		"usage: node scripts/mint-agent-token.mjs <agent_name> [--assignee <name>] [--projects <csv>]",
	);
	process.exit(1);
}

const { mintAgentToken } = await import("../src/lib/server/db.js");

let minted;
try {
	minted = mintAgentToken({
		agent_name,
		scope_assignee: flags.assignee ?? null,
		scope_projects: flags.projects ?? null,
	});
} catch (e) {
	console.error(`mint failed: ${e.message}`);
	process.exit(1);
}

const scopeDesc =
	[
		flags.assignee ? `assignee=${flags.assignee}` : null,
		flags.projects ? `projects=${flags.projects}` : null,
	]
		.filter(Boolean)
		.join(" AND ") || "UNSCOPED — full tracker access; are you sure this is what you wanted?";

console.log(`
Minted agent-API token #${minted.id} for '${agent_name}'
  scope: ${scopeDesc}
  db:    ${process.env.TASKS_DB_PATH}

  TOKEN (shown ONCE — only its sha256 is stored; it cannot be recovered):

    ${minted.token}

  Try it:

    curl -sS https://tasks.example.com/api/agent/rpc \\
      -H 'Authorization: Bearer ${minted.token}' \\
      -H 'Content-Type: application/json' \\
      -d '{"op":"get_ready","args":{}}'

  Revoke: revokeAgentToken(${minted.id}) or revokeAgentToken('${agent_name}') in src/lib/server/db.js.
`);
