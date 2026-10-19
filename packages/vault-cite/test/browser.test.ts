import { execFileSync } from "node:child_process";
import type * as fs from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { chromium } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { Cite, Store } from "../src/index.ts";
import { Network } from "../src/network.ts";
import type { Reply, Transport } from "../src/network.ts";
import { requireTools } from "./tools.ts";
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
	async (context) => {
		requireTools(context, ["pdfinfo", "pdftotext"]);

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

		expect(source.artifacts.map((a) => a.mime)).toEqual([
			"text/html",
			"application/pdf",
			"text/html",
		]);

		expect(source.artifacts[0]?.role).toBe("ORIGINAL");

		expect(readFileSync(path.join(cite.store.root, source.artifacts[0]?.path ?? ""), "utf8")).toBe(
			page,
		);

		expect(
			source.artifacts
				.slice(1)
				.every(
					(artifact) => artifact.role === "DERIVED" && artifact.original_sha256 === source.sha256,
				),
		).toBe(true);

		const htmlArtifact = source.artifacts[2];

		if (!htmlArtifact) {
			throw new Error("missing html");
		}

		const html = readFileSync(path.join(cite.store.root, htmlArtifact.path), "utf8");

		expect(html).toContain("default-src 'none'");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<link");
		expect(html).toContain("color:rgb(255, 0, 0)");
		expect((await cite.derive()).saved).toBe(1);
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
				: new URL(url).hostname === "api.github.com"
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
	expect((await cite.derive()).saved).toBe(1);
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

it.skipIf(!process.env["CITE_BROWSER_TESTS"])(
	"extracts native pages and locally OCRs scanned pages in a separate queued step",
	async (context) => {
		requireTools(context, ["pdfinfo", "pdftotext", "pdftoppm", "tesseract"]);

		const browser = await chromium.launch({
			...(process.env["CITE_CHROMIUM_EXECUTABLE"]
				? { executablePath: process.env["CITE_CHROMIUM_EXECUTABLE"] }
				: {}),
			headless: true,
		});
		let pdf: Buffer;

		try {
			const page = await browser.newPage({ viewport: { width: 800, height: 200 } });

			await page.setContent(
				'<html><body><h1 style="font:40px Arial">Scanned Archive Evidence</h1></body></html>',
			);

			const scan = await page.screenshot();

			await page.setContent(
				`<html><body><div style="break-after:page"><h1>Native Evidence</h1></div><img width="800" src="data:image/png;base64,${scan.toString("base64")}"></body></html>`,
			);

			pdf = await page.pdf({ width: "900px", height: "600px" });
		} finally {
			await browser.close();
		}

		const cite = setup((url) =>
			reply(url, url.endsWith("robots.txt") ? "" : pdf, "application/pdf"),
		);
		const result = await cite.add("https://publisher.example/scanned.pdf");

		expect(result.source?.access_status).toBe("SAVED");
		expect(cite.store.search("Archive")).toHaveLength(0);
		expect((await cite.derive()).saved).toBe(1);
		expect(cite.store.search("Archive")).toHaveLength(1);
		const row = cite.store.derivation(result.source?.id ?? "");
		const manifest = z.object({ manifest: z.string() }).parse(row);
		const artifact = z
			.object({ path: z.string(), original_sha256: z.string() })
			.parse(JSON.parse(manifest.manifest));

		expect(artifact.original_sha256).toBe(result.source?.sha256);
		expect(artifact.path).toMatch(/^derived\//);

		const output: unknown = JSON.parse(
			readFileSync(path.join(cite.store.root, artifact.path), "utf8"),
		);

		expect(output).toMatchObject({
			role: "DERIVED",
			original_sha256: result.source?.sha256,
			pages: [
				{ page: 1, method: "pdftotext", text: "Native Evidence" },
				{ page: 2, method: "tesseract-eng", text: "Scanned Archive Evidence" },
			],
		});
	},
	60_000,
);

it.skipIf(!process.env["CITE_BROWSER_TESTS"])(
	"disables inline scripts and event handlers before navigation",
	async () => {
		const html = `<!doctype html><html><head><title>Original static title</title></head><body onload="document.querySelector('#handler').textContent='EVENT HANDLER EXECUTED'">
 <p id="inline">Original inline control text remains visible in this static snapshot, captured before any untrusted code can replace it.</p>
 <p id="handler">Original handler control text must remain unchanged after the load event.</p>
 <p>This unaffected paragraph keeps the page eligible for capture even if both hostile controls execute, so admission checks cannot hide the JavaScript regression.</p>
 <script>document.title='INLINE SCRIPT EXECUTED';document.querySelector('#inline').textContent='INLINE SCRIPT EXECUTED';</script>
 </body></html>`;
		const cite = setup((url) => reply(url, url.endsWith("robots.txt") ? "" : html));
		const result = await cite.add("https://publisher.example/static-control");

		expect(result.source?.title).toBe("Original static title");
		const original = result.source?.artifacts.find((item) => item.role === "ORIGINAL");
		const snapshot = result.source?.artifacts.find(
			(item) => item.role === "DERIVED" && item.mime === "text/html",
		);

		if (!original || !snapshot) {
			throw new Error("Missing capture artifacts");
		}

		expect(readFileSync(path.join(cite.store.root, original.path), "utf8")).toBe(html);
		const derived = readFileSync(path.join(cite.store.root, snapshot.path), "utf8");

		expect(derived).toContain("Original inline control text remains visible");
		expect(derived).toContain("Original handler control text must remain unchanged");
		expect(derived).not.toContain("INLINE SCRIPT EXECUTED");
		expect(derived).not.toContain("EVENT HANDLER EXECUTED");
		expect(derived).not.toContain("onload=");
	},
	30_000,
);
