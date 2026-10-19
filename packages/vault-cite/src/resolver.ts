/* oxlint-disable eslint/no-await-in-loop -- Sequential processing bounds resource use and preserves pacing, redirect and retry order. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { snapshot } from "./browser.ts";
import { CaptureError, normalize } from "./model.ts";
import type { Capture } from "./model.ts";
import type { Network, Reply } from "./network.ts";
const exec = promisify(execFile);

const unpaywallEmail = "291627965+returnsvoidjanet@users.noreply.github.com";

const oaSchema = z.object({
	title: z.string().nullable(),
	z_authors: z
		.array(z.object({ given: z.string().optional(), family: z.string().optional() }))
		.optional(),
	best_oa_location: z.object({ url_for_pdf: z.string().nullable() }).nullable(),
});

async function pdf(reply: Reply, canonicalId: string, network: Network): Promise<Capture> {
	if (!reply.body.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
		throw new CaptureError("INACCESSIBLE", "Expected PDF; received unavailable or gated content");
	}

	const dir = mkdtempSync(path.join(network.store.root, ".extract-"));
	const filePath = path.join(dir, "source.pdf");

	try {
		writeFileSync(filePath, reply.body, { mode: 0o600 });

		// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- Poppler names this encoding UTF-8.
		const { stdout: text } = await exec("pdftotext", ["-enc", "UTF-8", filePath, "-"], {
			timeout: 30_000,
			maxBuffer: 16 * 1024 ** 2,
		});
		const { stdout: info } = await exec("pdfinfo", [filePath], {
			timeout: 10_000,
			maxBuffer: 65536,
		});

		if (!text.trim()) {
			throw new CaptureError("FAILED", "PDF has no extractable text (OCR not configured)");
		}

		const pdfTitle = /^Title:[ \t]*([^\s][^\r\n]*)$/m.exec(info)?.[1]?.trim();
		const title = pdfTitle ?? canonicalId;
		const author = /^Author:[ \t]*([^\r\n]*)$/m.exec(info)?.[1]?.trim();

		return {
			canonicalId,
			url: reply.url,
			title,
			authors: author ? [author] : [],
			extractor: "poppler-pdftotext",
			text,
			artifacts: [{ data: reply.body, mime: "application/pdf" }],
		};
	} finally {
		unlinkSync(filePath);
		rmdirSync(dir);
	}
}

async function github(url: URL, network: Network): Promise<Capture> {
	const parts = url.pathname.split("/").filter(Boolean);
	const [owner, repo, kind, ...tail] = parts;

	if (!owner || !repo || (kind && !["tree", "blob", "commit"].includes(kind))) {
		throw new CaptureError("FAILED", "Expected GitHub repository, tree, blob or commit URL");
	}

	if (
		(kind === "tree" && tail.length > 1) ||
		(kind === "blob" && !/^[a-f0-9]{40}$/.test(tail[0] ?? ""))
	) {
		throw new CaptureError("FAILED", "Use a commit permalink for GitHub file or nested tree paths");
	}

	// Slash-containing branch names are ambiguous; use a commit permalink for those.
	const ref = tail[0] ?? "HEAD";
	const base = `${encodeURIComponent(owner)}/${encodeURIComponent(repo.replace(/\.git$/, ""))}`;
	const response = await network.get(
		`https://api.github.com/repos/${base}/commits/${encodeURIComponent(ref)}`,
	);
	const commit = z
		.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
		.parse(JSON.parse(response.body.toString()));
	const archive = await network.get(`https://codeload.github.com/${base}/tar.gz/${commit.sha}`);

	if (archive.body[0] !== 0x1f || archive.body[1] !== 0x8b) {
		throw new CaptureError("FAILED", "GitHub archive is not gzip");
	}

	const dir = mkdtempSync(path.join(network.store.root, ".archive-"));
	const filePath = path.join(dir, "repo.tgz");

	try {
		writeFileSync(filePath, archive.body, { mode: 0o600 });

		const { stdout: names } = await exec("tar", ["-tzf", filePath], {
			timeout: 30_000,
			maxBuffer: 2 * 1024 ** 2,
		});
		const files = names
			.split("\n")
			.filter((name) => /^[^/]+\/(?:README[^/]*|LICENSE[^/]*)$/i.test(name))
			.slice(0, 10);
		const texts = [];

		for (const name of files) {
			texts.push(
				(
					await exec("tar", ["-xOzf", filePath, "--", name], {
						timeout: 10_000,
						maxBuffer: 1024 ** 2,
					})
				).stdout,
			);
		}

		return {
			canonicalId: `github:${owner}/${repo}@${commit.sha}`,
			url: `https://github.com/${base}/tree/${commit.sha}`,
			title: `${owner}/${repo} @ ${commit.sha}`,
			authors: [owner],
			extractor: "tar-readme-v1",
			text: texts.join("\n") || names,
			artifacts: [{ data: archive.body, mime: "application/gzip" }],
		};
	} finally {
		unlinkSync(filePath);
		rmdirSync(dir);
	}
}

export async function resolveSource(ref: string, network: Network): Promise<Capture> {
	const canonical = normalize(ref);

	if (canonical.startsWith("arxiv:")) {
		const id = canonical.slice(6);

		const abstract = await network.get(`https://arxiv.org/abs/${id}`);
		const capture = await pdf(await network.get(`https://arxiv.org/pdf/${id}`), canonical, network);

		if (abstract.headers["content-type"]?.includes("text/html")) {
			const metadata = arxivMetadata(abstract.body.toString());

			capture.title = metadata.title ?? capture.title;
			capture.extractor = "poppler-pdftotext+arxiv-meta-v1";
			capture.authors = metadata.authors.length > 0 ? metadata.authors : capture.authors;
			capture.artifacts.push({ data: abstract.body, mime: "text/html" });
		}

		return capture;
	}

	if (canonical.startsWith("doi:")) {
		const doi = canonical.slice(4);
		const metadata = await network.get(
			`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(unpaywallEmail)}`,
		);
		const oa = oaSchema.parse(JSON.parse(metadata.body.toString()));

		if (!oa.best_oa_location?.url_for_pdf) {
			throw new CaptureError("INACCESSIBLE", "Unpaywall has no open-access PDF");
		}

		const capture = await pdf(
			await network.get(oa.best_oa_location.url_for_pdf),
			canonical,
			network,
		);

		capture.title = oa.title ?? capture.title;

		capture.authors =
			oa.z_authors?.map((author) => [author.given, author.family].filter(Boolean).join(" ")) ??
			capture.authors;

		return capture;
	}

	const url = new URL(canonical);

	if (url.hostname === "github.com") {
		return github(url, network);
	}

	const reply = await network.get(canonical);

	if (
		reply.headers["content-type"]?.includes("application/pdf") ||
		reply.body.subarray(0, 5).toString() === "%PDF-"
	) {
		return pdf(reply, canonical, network);
	}

	if (!reply.headers["content-type"]?.includes("text/html")) {
		throw new CaptureError("FAILED", "Unsupported source media type");
	}

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

		const decoded = value.replace(
			/&(?:amp|lt|gt|quot|apos);/g,
			(entity) =>
				({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] ??
				entity,
		);

		if (attributes.get("name") === "citation_title") {
			title = decoded;
		}

		if (attributes.get("name") === "citation_author") {
			authors.push(decoded);
		}
	}

	return { title, authors };
}
