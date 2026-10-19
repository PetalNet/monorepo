import { execFileSync } from "node:child_process";
import type * as fs from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { Cite, Store } from "../src/index.ts";
import { Network } from "../src/network.ts";
import type { Reply, Transport } from "../src/network.ts";
const stores: Store[] = [];

function setup(transport: Transport) {
	const store = new Store(mkdtempSync(path.join(process.cwd(), ".cite-browser-")));

	stores.push(store);

	return new Cite(store, new Network(store, transport, 0));
}

afterEach(() => {
	for (const store of stores.splice(0)) {
		store.close();
		rmSync(store.root, { recursive: true });
	}
});

const reply = (url: string, body: string | Buffer, type = "text/html"): Reply => ({
	url,
	status: 200,
	body: Buffer.from(body),
	headers: { "content-type": type },
});

it.skipIf(!process.env["CITE_BROWSER_TESTS"])(
	"renders a self-contained inert HTML snapshot and matching PDF",
	async () => {
		const page =
			'<!doctype html><html><head><title>Static primary evidence</title><link rel="stylesheet" href="/style.css"></head><body><h1>Primary evidence</h1><p>This is the primary source text captured from the original page, with enough content to distinguish it from a login shell.</p><script>fetch("https://private.example/")</script></body></html>';
		const urls: string[] = [];
		const cite = setup((url) => {
			urls.push(url);

			return reply(
				url,
				url.endsWith("robots.txt") ? "" : url.endsWith("style.css") ? "h1 {color: red}" : page,
				url.endsWith("style.css") ? "text/css" : "text/html",
			);
		});
		const result = await cite.add("https://publisher.example/page");

		expect(result.job?.state, result.job?.reason ?? "").toBe("SAVED");
		const source = result.source;

		if (!source) {
			throw new Error("missing source");
		}

		expect(source.artifacts.map((a) => a.mime)).toEqual(["application/pdf", "text/html"]);
		const htmlArtifact = source.artifacts[1];

		if (!htmlArtifact) {
			throw new Error("missing html");
		}

		const html = readFileSync(path.join(cite.store.root, htmlArtifact.path), "utf8");

		expect(html).toContain("default-src 'none'");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<link");
		expect(html).toContain("color:rgb(255, 0, 0)");
		expect(cite.store.search('"primary source text"')).toHaveLength(1);
		expect(urls).not.toContain("https://private.example/");
	},
	30_000,
);

it.skipIf(!process.env["CITE_BROWSER_TESTS"])(
	"does not save login pages as primary sources",
	async () => {
		const cite = setup((url) =>
			reply(
				url,
				url.endsWith("robots.txt")
					? ""
					: '<html><body>Sign in to continue<input type="password"></body></html>',
			),
		);

		expect((await cite.add("https://publisher.example/login")).job?.state).toBe("INACCESSIBLE");
	},
	30_000,
);

it("pins GitHub archives to the resolved commit and extracts README text", async () => {
	const sha = "a".repeat(40);
	let archive = Buffer.alloc(0);
	const urls: string[] = [];
	const cite = setup((url) => {
		urls.push(url);

		return reply(
			url,
			url.endsWith("robots.txt")
				? ""
				: url.includes("api.github.com")
					? JSON.stringify({ sha })
					: archive,
			"application/gzip",
		);
	});
	const dir = path.join(cite.store.root, "repo");

	mkdirSync(dir);
	writeFileSync(path.join(dir, "README.md"), "Immutable repository reference");
	archive = execFileSync("tar", ["-czf", "-", "-C", cite.store.root, "repo"]);
	const result = await cite.add("https://github.com/example/project/tree/main");

	expect(result.source?.canonical_id).toBe(`github:example/project@${sha}`);
	expect(urls).toContain(`https://codeload.github.com/example/project/tar.gz/${sha}`);
	expect(cite.store.search("Immutable")).toHaveLength(1);
});

it("selects primary-scope papers before the rest, parses quoted CSV and deduplicates", () => {
	const cite = setup((url) => reply(url, ""));
	const csv = path.join(cite.store.root, "input.csv");

	writeFileSync(
		csv,
		'citation_key,example_raw,primary_scope,unused\narxiv:1706.03762,https://arxiv.org/abs/1706.03762,1,"quoted, field"\ndoi:10.1234/example,https://doi.org/10.1234/example,0,x\nexample.org/report.pdf,https://example.org/report.pdf,1,x\nexample.org,https://example.org,1,x\n',
	);

	expect(cite.backfill(csv, "papers")).toEqual({
		selected: 2,
		enqueued: 2,
		existing: 0,
		invalid: 0,
	});

	expect(cite.backfill(csv, "papers")).toEqual({
		selected: 2,
		enqueued: 0,
		existing: 2,
		invalid: 0,
	});

	expect(cite.backfill(csv, "rest").enqueued).toBe(2);
});

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof fs>()),
	statfsSync: () => ({ bavail: 40 * 1024 ** 3, bsize: 1 }),
}));
