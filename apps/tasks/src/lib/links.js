// Links an artifact carries out to GitHub: the PR or issue it demos or decides, and repo and commit
// refs. Stored as a small JSON list of { url, kind, label } on the artifact.
export const LINK_KINDS = ["pr", "issue", "commit", "repo", "link"];

const GITHUB =
	/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(pull|issues|commit)\/([\w]+))?\/?$/;
const SHORT = /^([\w.-]+)\/([\w.-]+)(?:#(\d+)|@([0-9a-f]{7,40}))?$/;

// Accepts a full GitHub URL or "owner/repo", "owner/repo#12" (a PR; GitHub redirects an issue
// number), "owner/repo@sha", and returns the canonical URL, or undefined when it is none of those.
export function canonicalLink(text) {
	const raw = String(text ?? "").trim();
	const short = SHORT.exec(raw);

	if (short) {
		const [, owner, repo, number, sha] = short;
		const base = `https://github.com/${owner}/${repo}`;

		return number ? `${base}/pull/${number}` : sha ? `${base}/commit/${sha}` : base;
	}

	const m = GITHUB.exec(raw.replace(/[?#].*$/, "").replace(/\/+$/, ""));

	return m ? `https://github.com/${m[1]}/${m[2]}${m[3] ? `/${m[3]}/${m[4]}` : ""}` : undefined;
}

// One link from Janet's page JSON: { url, kind?, label? }. GitHub URLs get their kind and a label
// ("owner/repo#12") for free; any other https URL is kept as a plain link.
export function normalizeLink(input) {
	const given = typeof input === "string" ? { url: input } : input;
	const url = canonicalLink(given?.url) ?? httpsUrl(given?.url);

	if (!url) {
		throw new Error(`link must be a GitHub reference or an https URL: ${given?.url}`);
	}

	const m = GITHUB.exec(url);
	const kind =
		given.kind ?? (m ? { pull: "pr", issues: "issue", commit: "commit" }[m[3]] || "repo" : "link");

	if (!LINK_KINDS.includes(kind)) {
		throw new Error(`link kind must be one of ${LINK_KINDS.join(", ")}`);
	}

	const label =
		given.label ??
		(m
			? `${m[1]}/${m[2]}${m[3] === "commit" ? `@${m[4].slice(0, 7)}` : m[3] ? `#${m[4]}` : ""}`
			: new URL(url).host);

	return { url, kind, label: String(label).slice(0, 80) };
}

function httpsUrl(text) {
	try {
		const u = new URL(String(text));

		return u.protocol === "https:" ? u.href : undefined;
	} catch {
		return undefined;
	}
}

export function normalizeLinks(list) {
	if (!Array.isArray(list) || list.length > 20) {
		throw new Error("links must be a list of at most 20");
	}

	const byUrl = new Map(list.map(normalizeLink).map((l) => [l.url, l]));

	return [...byUrl.values()];
}
