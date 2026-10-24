/* oxlint-disable eslint/no-await-in-loop -- Sequential processing bounds resource use and preserves pacing, redirect and retry order. */
import { z } from "zod";

import { CaptureError, normalize } from "./model.ts";
import type { Capture } from "./model.ts";
import { decoded, original } from "./network.ts";
import type { Network, Reply } from "./network.ts";

const unpaywallEmail = "291627965+returnsvoidjanet@users.noreply.github.com";

const oaSchema = z.object({
	title: z.string().nullable(),
	z_authors: z
		.array(z.object({ given: z.string().optional(), family: z.string().optional() }))
		.optional(),
	best_oa_location: z.object({ url_for_pdf: z.string().nullable() }).nullable(),
});

function captured(reply: Reply, canonicalId: string): Capture {
	return {
		canonicalId,
		url: reply.url,
		title: canonicalId,
		authors: [],
		extractor: "http-original-v2",
		artifacts: [original(reply)],
	};
}

function pdf(reply: Reply, canonicalId: string): Capture {
	if (!decoded(reply).subarray(0, 5).equals(Buffer.from("%PDF-"))) {
		throw new CaptureError("INACCESSIBLE", "Expected PDF; received unavailable or gated content");
	}

	const capture = captured(reply, canonicalId);
	const artifact = capture.artifacts[0];

	if (artifact) {
		artifact.mime = "application/pdf";
	}

	return capture;
}

// Code URLs are pinned to a commit. Issues, pulls, releases, profiles and other GitHub pages return
// undefined and are captured as ordinary pages.
async function github(url: URL, network: Network): Promise<Capture | undefined> {
	const parts = url.pathname.split("/").filter(Boolean);
	const [owner, repo, kind, ...tail] = parts;

	if (!owner || !repo || (kind && !["tree", "blob", "commit"].includes(kind))) {
		return undefined;
	}

	// A branch or tag containing "/" is indistinguishable from a path here; the first segment is the ref.
	const [ref = "HEAD", ...path] = tail.map((segment) => decodeURIComponent(segment));

	if (kind === "blob" && path.length === 0) {
		throw new CaptureError("FAILED", "Expected a file path in GitHub blob URL");
	}

	const base = `${encodeURIComponent(owner)}/${encodeURIComponent(repo.replace(/\.git$/, ""))}`;
	// One file entry keeps the stored resolution small; only the commit SHA and metadata matter.
	const resolution = await network.get(
		`https://api.github.com/repos/${base}/commits/${encodeURIComponent(ref)}?per_page=1`,
	);
	const commit = z
		.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
		.parse(JSON.parse(decoded(resolution).toString()));
	const pinned = `${owner}/${repo}@${commit.sha}${path.length > 0 ? `/${path.join("/")}` : ""}`;
	let capture: Capture;

	if (kind === "blob") {
		capture = captured(
			await network.get(
				`https://raw.githubusercontent.com/${base}/${commit.sha}/${path.map(encodeURIComponent).join("/")}`,
			),
			`github:${pinned}`,
		);
	} else {
		const archive = await network.get(`https://codeload.github.com/${base}/tar.gz/${commit.sha}`);

		if (decoded(archive)[0] !== 0x1f || decoded(archive)[1] !== 0x8b) {
			throw new CaptureError("FAILED", "GitHub archive is not gzip");
		}

		capture = captured(archive, `github:${pinned}`);
		const artifact = capture.artifacts[0];

		if (artifact) {
			artifact.mime = "application/gzip";
		}
	}

	capture.title = pinned.replace("@", " @ ");
	capture.authors = [owner];

	// The citation named a branch, tag or HEAD, which moves. Keep the dated API answer that pinned it.
	if (!(/^[a-f0-9]{7,40}$/.test(ref) && commit.sha.startsWith(ref))) {
		capture.title += ` (cited ref ${ref})`;
		capture.artifacts.push(original(resolution));
	}

	return capture;
}

export async function resolveSource(ref: string, network: Network): Promise<Capture> {
	const canonical = normalize(ref);

	if (canonical.startsWith("arxiv:")) {
		const id = canonical.slice(6);

		const abstract = await network.get(`https://arxiv.org/abs/${id}`);
		const capture = pdf(await network.get(`https://arxiv.org/pdf/${id}`), canonical);

		if (abstract.headers["content-type"]?.includes("text/html")) {
			const metadata = arxivMetadata(decoded(abstract).toString());

			capture.title = metadata.title ?? capture.title;
			capture.extractor = "http-original+arxiv-meta-v2";
			capture.authors = metadata.authors.length > 0 ? metadata.authors : capture.authors;
			capture.artifacts.push(original(abstract));
		}

		return capture;
	}

	if (canonical.startsWith("doi:")) {
		const doi = canonical.slice(4);
		const metadata = await network.get(
			`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(unpaywallEmail)}`,
		);
		const oa = oaSchema.parse(JSON.parse(decoded(metadata).toString()));

		if (!oa.best_oa_location?.url_for_pdf) {
			throw new CaptureError("INACCESSIBLE", "Unpaywall has no open-access PDF");
		}

		const capture = pdf(await network.get(oa.best_oa_location.url_for_pdf), canonical);

		capture.title = oa.title ?? capture.title;

		capture.authors =
			oa.z_authors?.map((author) => [author.given, author.family].filter(Boolean).join(" ")) ??
			capture.authors;

		return capture;
	}

	const url = new URL(canonical);

	const code = url.hostname === "github.com" ? await github(url, network) : undefined;

	if (code) {
		return code;
	}

	const reply = await network.get(canonical);

	if (
		reply.headers["content-type"]?.includes("application/pdf") ||
		reply.body.subarray(0, 5).toString() === "%PDF-"
	) {
		return pdf(reply, canonical);
	}

	if (!reply.headers["content-type"]?.includes("text/html")) {
		return captured(reply, canonical);
	}

	// Loaded on demand: Playwright is heavy, and the fetch hook never needs it.
	const { snapshot } = await import("./browser.ts");
	const capture = await snapshot(reply, network);

	capture.canonicalId = canonical;

	return capture;
}

function arxivMetadata(html: string) {
	let title: string | undefined;
	const authors: string[] = [];

	for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
		const attributes = new Map<string, string>();

		for (const attribute of tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)) {
			const key = attribute[1];
			const value = attribute[3];

			if (key && value !== undefined) {
				attributes.set(key.toLowerCase(), value);
			}
		}

		const value = attributes.get("content");

		if (!value) {
			continue;
		}

		const decodedValue = value.replace(
			/&(?:amp|lt|gt|quot|apos);/g,
			(entity) =>
				({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] ??
				entity,
		);

		if (attributes.get("name") === "citation_title") {
			title = decodedValue;
		}

		if (attributes.get("name") === "citation_author") {
			authors.push(decodedValue);
		}
	}

	return { title, authors };
}
