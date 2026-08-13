#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
	Client,
	ClientCredentialsProvider,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const developmentSecret = "grove-mcp-development-only-secret";
const root = fileURLToPath(new URL("../../../", import.meta.url));

const usage = () => {
	console.error(
		"Usage: vp node --use-system-ca apps/grove/scripts/enroll-dev-agent.mjs --subject <unique-id> --name <display-name>",
	);
};

const option = (name) => {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
};

const subject = option("--subject")?.trim();
const name = option("--name")?.trim();
if (!subject || subject.length > 200 || !name || name.length > 80) {
	usage();
	process.exit(2);
}

const portal = async (service) => {
	const manifest = JSON.parse(await readFile(`${root}.amp/portals/${service}.json`, "utf8"));
	const value = manifest?.links?.[0]?.url;
	if (typeof value !== "string") throw new Error(`${service} portal manifest has no URL`);
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password)
		throw new Error(`${service} portal manifest does not contain a safe HTTPS URL`);
	return url;
};

const grovePortal = await portal("grove");
const oidcPortal = await portal("grove-oidc");
const endpoint = new URL("/mcp", grovePortal);
const issuer = new URL("/realms/grove-mcp", oidcPortal).href.replace(/\/$/, "");
const authProvider = new ClientCredentialsProvider({
	clientId: subject,
	clientSecret: process.env.GROVE_MCP_CLIENT_SECRET ?? developmentSecret,
	scope: "grove:mcp grove:agent:enroll",
	expectedIssuer: issuer,
});
const client = new Client(
	{ name: "grove-development-agent-enrollment", version: "1.0.0" },
	{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
);

try {
	await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider }));
	const enrolled = await client.callTool({
		name: "agents.enrollSelf",
		arguments: { name },
	});
	if (enrolled.isError) throw new Error("Grove rejected Agent enrollment");
	process.stdout.write(
		`${JSON.stringify(
			{
				status: "enrolled",
				subject,
				endpoint: endpoint.href,
				actor: enrolled.structuredContent,
			},
			null,
			2,
		)}\n`,
	);
} finally {
	await client.close();
}
