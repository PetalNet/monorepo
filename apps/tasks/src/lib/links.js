// Links an artifact carries out to GitHub: the PR or issue it demos or decides, and repo and commit
// refs. Stored as a small JSON list of { url, kind, label } on the artifact.
const LINK_KINDS = ["pr", "issue", "commit", "repo", "link"];

const URL_FORM =
	/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\/(?:(pull|issues)\/(\d+)(?:\/(?:files|commits|checks))?|commit\/([0-9a-f]{7,40})))?\/?$/i;
const SHORT_FORM = /^([\w-]+)\/([\w.-]+?)(?:#(\d+)|@([0-9a-f]{7,40}))?$/i;

// Read a GitHub reference in any accepted form: a URL (query, fragment and /files-style tails are
// ignored), or "owner/repo", "owner/repo#12" (a PR; GitHub redirects an issue number),
// "owner/repo@sha". Owner and repo are case-insensitive on GitHub, so they are lower-cased.
function parseGitHub(text) {
	const raw = String(text ?? "").trim();
	const short = SHORT_FORM.exec(raw);

	if (short) {
		const [, owner, repo, number, sha] = short;

		return { owner, repo, type: number ? "pull" : sha ? "commit" : "repo", id: number ?? sha };
	}

	const m = URL_FORM.exec(raw.replace(/[?#].*$/, ""));

	if (!m) {
		return undefined;
	}

	const [, owner, repo, kind, number, sha] = m;

	return { owner, repo, type: kind ?? (sha ? "commit" : "repo"), id: number ?? sha };
}

const toUrl = ({ owner, repo, type, id }) => {
	const base = `https://github.com/${owner}/${repo}`.toLowerCase();

	return type === "repo" ? base : `${base}/${type === "commit" ? "commit" : type}/${id}`;
};

// The canonical URL of a GitHub reference, or undefined when it is not one.
export const canonicalLink = (text) => {
	const ref = parseGitHub(text);

	return ref && toUrl(ref);
};

const KIND = { pull: "pr", issues: "issue", commit: "commit", repo: "repo" };

// One link from Janet's page JSON: { url, kind?, label? }, or just the reference string. GitHub
// references get their kind and a label ("owner/repo#12") for free; any other https URL is kept
// as a plain link. Anything else (http, javascript:, data:) is refused.
function normalizeLink(input) {
	const given = typeof input === "string" ? { url: input } : input;
	const ref = parseGitHub(given?.url);
	const url = ref ? toUrl(ref) : httpsUrl(given?.url);

	if (!url) {
		throw new Error(`link must be a GitHub reference or an https URL: ${given?.url}`);
	}

	const kind = given.kind ?? (ref ? KIND[ref.type] : "link");

	if (!LINK_KINDS.includes(kind)) {
		throw new Error(`link kind must be one of ${LINK_KINDS.join(", ")}`);
	}

	const name = ref && `${ref.owner}/${ref.repo}`;
	const label =
		given.label ??
		(ref
			? ({ repo: name, commit: `${name}@${ref.id?.slice(0, 7)}` }[ref.type] ?? `${name}#${ref.id}`)
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

	return [...new Map(list.map(normalizeLink).map((l) => [l.url, l])).values()];
}
