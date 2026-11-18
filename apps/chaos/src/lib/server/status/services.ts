/** What a company's own status page says, reduced to four levels by code. */
export type ClaimLevel = "ok" | "degraded" | "outage" | "maintenance";

export interface Claim {
	level: ClaimLevel;
	/** The page's own words, shown as written. */
	text: string;
}

export interface Service {
	id: string;
	name: string;
	/** The status page a person would read. */
	page: string;
	/** The machine-readable feed of that page, and how to read it. */
	feed: string;
	parse: (body: string) => Claim;
	/** Heavy feeds are read less often. */
	slow?: true;
	/** One small public endpoint of the service itself. Any answer below 500 counts as reachable. */
	probe: string;
}

function json(body: string): unknown {
	return JSON.parse(body) as unknown;
}

function text(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new TypeError(`status feed: no ${what}`);
	}

	return value.trim();
}

const STATUSPAGE = new Map<string, ClaimLevel>([
	["none", "ok"],
	["minor", "degraded"],
	// Statuspage words "major" as a partial outage. Only "critical" is the whole service.
	["major", "degraded"],
	["critical", "outage"],
	["maintenance", "maintenance"],
]);

/** Atlassian Statuspage's `status.json`, used by most of the services here. */
function parseStatuspage(body: string): Claim {
	const { status } = json(body) as { status?: { indicator?: unknown; description?: unknown } };
	const level = STATUSPAGE.get(text(status?.indicator, "indicator"));

	if (!level) {
		throw new TypeError(`status feed: unknown indicator ${String(status?.indicator)}`);
	}

	return { level, text: text(status?.description, "description") };
}

function parseSlack(body: string): Claim {
	const { status, active_incidents: incidents } = json(body) as {
		status?: unknown;
		active_incidents?: { title?: unknown; type?: unknown }[];
	};

	if (text(status, "status") === "ok") {
		return { level: "ok", text: "No active incidents" };
	}

	const first = (incidents ?? []).at(0);

	return {
		level: first?.type === "outage" ? "outage" : "degraded",
		text: text(first?.title, "incident title"),
	};
}

/**
 * Google Cloud lists every recent incident. One without an end is still open. An incident covers
 * some products in some regions, so it is never read as a full outage: our probe reaches one
 * endpoint and cannot speak for the rest.
 */
function parseGoogleCloud(body: string): Claim {
	const incidents = json(body);

	if (!Array.isArray(incidents)) {
		throw new TypeError("status feed: no incident list");
	}

	const open = (incidents as { end?: unknown; external_desc?: unknown }[]).filter(
		(incident) => !incident.end,
	);
	const first = open.at(0);

	if (!first) {
		return { level: "ok", text: "No open incidents" };
	}

	const more = open.length > 1 ? ` (and ${String(open.length - 1)} more)` : "";

	return { level: "degraded", text: `${text(first.external_desc, "incident description")}${more}` };
}

/**
 * AWS lists its open events, each tied to one region. A regional event is never read as a full
 * outage here, because our probe reaches one global endpoint and cannot speak for a region.
 */
function parseAws(body: string): Claim {
	const events = json(body);

	if (!Array.isArray(events)) {
		throw new TypeError("status feed: no event list");
	}

	if (events.length === 0) {
		return { level: "ok", text: "No open events" };
	}

	const named = (events as { summary?: unknown; region_name?: unknown }[]).map((event) => {
		const summary = text(event.summary, "event summary");

		return typeof event.region_name === "string" && event.region_name.trim() !== ""
			? `${summary} (${event.region_name.trim()})`
			: summary;
	});

	return {
		level: "degraded",
		text:
			named.length > 2
				? `${named.slice(0, 2).join(", ")} and ${String(named.length - 2)} more`
				: named.join(", "),
	};
}

const ENTITIES = new Map([
	["amp", "&"],
	["lt", "<"],
	["gt", ">"],
	["quot", '"'],
	["apos", "'"],
]);

function unescape(xml: string): string {
	return xml.replaceAll(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES.get(name) ?? "");
}

/** Azure's status feed is RSS with one item for each open event. An empty channel means none. */
function parseAzure(body: string): Claim {
	if (!/<channel[\s>]/.test(body)) {
		throw new TypeError("status feed: not an RSS channel");
	}

	const title = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(
		body,
	)?.[1];

	return title === undefined
		? { level: "ok", text: "No open events" }
		: { level: "degraded", text: text(unescape(title), "event title") };
}

const statuspage = (id: string, name: string, page: string, probe: string): Service => ({
	id,
	name,
	page,
	feed: `${page}/api/v2/status.json`,
	parse: parseStatuspage,
	probe,
});

export const SERVICES: readonly Service[] = [
	{
		id: "aws",
		name: "AWS",
		page: "https://health.aws.amazon.com/health/status",
		feed: "https://health.aws.amazon.com/public/currentevents",
		parse: parseAws,
		slow: true,
		probe: "https://sts.amazonaws.com/",
	},
	{
		id: "azure",
		name: "Azure",
		page: "https://azure.status.microsoft/en-us/status",
		feed: "https://azure.status.microsoft/en-us/status/feed/",
		parse: parseAzure,
		probe: "https://management.azure.com/",
	},
	{
		id: "gcp",
		name: "Google Cloud",
		page: "https://status.cloud.google.com",
		feed: "https://status.cloud.google.com/incidents.json",
		parse: parseGoogleCloud,
		slow: true,
		probe: "https://storage.googleapis.com/",
	},
	statuspage(
		"cloudflare",
		"Cloudflare",
		"https://www.cloudflarestatus.com",
		"https://www.cloudflare.com/cdn-cgi/trace",
	),
	statuspage("github", "GitHub", "https://www.githubstatus.com", "https://api.github.com/zen"),
	statuspage("openai", "OpenAI", "https://status.openai.com", "https://api.openai.com/v1/models"),
	statuspage(
		"anthropic",
		"Anthropic",
		"https://status.anthropic.com",
		"https://api.anthropic.com/v1/models",
	),
	statuspage(
		"discord",
		"Discord",
		"https://discordstatus.com",
		"https://discord.com/api/v10/gateway",
	),
	{
		id: "slack",
		name: "Slack",
		page: "https://slack-status.com",
		feed: "https://slack-status.com/api/v2.0.0/current",
		parse: parseSlack,
		probe: "https://slack.com/api/api.test",
	},
	statuspage("zoom", "Zoom", "https://status.zoom.us", "https://api.zoom.us/v2/"),
	statuspage(
		"atlassian",
		"Atlassian",
		"https://status.atlassian.com",
		"https://api.atlassian.com/",
	),
	statuspage("vercel", "Vercel", "https://www.vercel-status.com", "https://api.vercel.com/"),
	statuspage(
		"digitalocean",
		"DigitalOcean",
		"https://status.digitalocean.com",
		"https://api.digitalocean.com/v2/",
	),
	statuspage("twilio", "Twilio", "https://status.twilio.com", "https://api.twilio.com/"),
];
