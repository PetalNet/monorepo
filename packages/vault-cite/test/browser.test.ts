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

it.skipIf(!process.env["CITE_BROWSER_TESTS"])(
	"reproduces computed styles without repeating custom properties on every element",
	async () => {
		const tokens = Array.from(
			{ length: 300 },
			(_, index) => `--token-${String(index)}: "Design Token Font ${String(index)}", sans-serif;`,
		).join("");
		const css = `:root{${tokens}--brand:rgb(0, 128, 0)}
body{font-family:Georgia,serif;color:var(--brand);line-height:1.6;font-size:20px}
h1{font-weight:400;color:rgb(255, 0, 0);font-size:32px}
a{color:inherit}
.card{border:2px solid rgb(0, 0, 255);padding:12px;text-underline-offset:4px}
.card p{text-underline-offset:auto}
em{font-style:normal}
li{list-style-type:square}
.row{display:block;margin:0}`;
		const body = `<main><h1>Heading styled by tokens</h1><section class="card"><p>Primary source paragraph with <em>plain emphasis</em> and <a href="/next">a link</a>, long enough to pass admission.</p><ul><li>One</li><li>Two</li></ul></section><div>${'<span class="row">Row text</span>'.repeat(1500)}</div></main>`;
		const page = `<!doctype html><html><head><title>Fidelity</title><link rel="stylesheet" href="/style.css"></head><body>${body}</body></html>`;
		const cite = setup((url) =>
			reply(
				url,
				url.endsWith("robots.txt") ? "" : url.endsWith("style.css") ? css : page,
				url.endsWith("style.css") ? "text/css" : "text/html",
			),
		);
		const result = await cite.add("https://publisher.example/tokens");

		expect(result.job?.state, result.job?.reason ?? "").toBe("SAVED");

		const snapshot = result.source?.artifacts.find(
			(item) => item.role === "DERIVED" && item.mime === "text/html",
		);

		if (!snapshot) {
			throw new Error("Missing snapshot");
		}

		const html = readFileSync(path.join(cite.store.root, snapshot.path), "utf8");

		expect(html).not.toContain("--token-");
		expect(html).not.toContain("data-vault-cite-index");
		expect(html.length).toBeLessThan(1024 ** 2);

		const browser = await chromium.launch({
			...(process.env["CITE_CHROMIUM_EXECUTABLE"]
				? { executablePath: process.env["CITE_CHROMIUM_EXECUTABLE"] }
				: {}),
			headless: true,
		});

		try {
			const styles = async (content: string) => {
				const tab = await browser.newPage();

				await tab.setContent(content);

				return tab.evaluate(() =>
					[...document.body.querySelectorAll("*")].map((element) => {
						const style = getComputedStyle(element);

						return Object.fromEntries(
							[...style]
								.filter((key) => !key.startsWith("--"))
								.map((key) => [
									key,
									// Inlined lengths re-snap to layout units; ignore sub-0.05px drift.
									style
										.getPropertyValue(key)
										.replace(/\d+\.\d+/g, (number) => Number(number).toFixed(1)),
								]),
						);
					}),
				);
			};

			const expected = await styles(
				page.replace('<link rel="stylesheet" href="/style.css">', `<style>${css}</style>`),
			);
			const actual = await styles(html);

			expect(actual).toHaveLength(expected.length);

			const mismatches = expected.flatMap((properties, index) =>
				Object.entries(properties)
					.filter(([key, value]) => actual[index]?.[key] !== value)
					.map(
						([key, value]) => `${String(index)} ${key}: ${value} -> ${actual[index]?.[key] ?? ""}`,
					),
			);

			expect(mismatches).toEqual([]);
		} finally {
			await browser.close();
		}
	},
	60_000,
);

it.skipIf(!process.env["CITE_BROWSER_TESTS"])(
	"fails a page whose rendered snapshot exceeds the size limit",
	async () => {
		const image = Buffer.alloc(1024 ** 2, 1);
		const page = `<!doctype html><html><head><title>Repeated image</title></head><body><p>Primary source text repeated alongside one large image used many times on the page.</p>${'<img src="/big.png">'.repeat(40)}</body></html>`;
		const cite = setup((url) =>
			url.endsWith("big.png")
				? reply(url, image, "image/png")
				: reply(url, url.endsWith("robots.txt") ? "" : page),
		);
		const result = await cite.add("https://publisher.example/repeated-image");

		expect(result.job?.state).toBe("FAILED");
		expect(result.job?.reason).toBe("Rendered snapshot exceeds 32 MiB limit");
	},
	60_000,
);

const failedAsset = (url: string, status = 404): Reply => ({
	url,
	status,
	body: Buffer.alloc(0),
	headers: {},
});

it.skipIf(!process.env["CITE_BROWSER_TESTS"])(
	"saves a page as PARTIAL with its missing assets recorded when one asset fails to fetch",
	async () => {
		const page =
			'<!doctype html><html><head><title>Partial capture coverage</title><link rel="stylesheet" href="/broken.css"></head><body><p>Primary source text long enough to clear the eighty character admission check comfortably for this page.</p></body></html>';
		const cite = setup((url) =>
			url.endsWith("robots.txt")
				? reply(url, "")
				: url.endsWith("broken.css")
					? failedAsset(url)
					: reply(url, page),
		);
		const result = await cite.add("https://publisher.example/partial-asset");

		expect(result.job?.state, result.job?.reason ?? "").toBe("SAVED");
		const source = result.source;

		if (!source) {
			throw new Error("missing source");
		}

		expect(source.source_type).toBe("PRIMARY");
		expect(source.completeness).toBe("PARTIAL");

		expect(source.missing_assets).toEqual([
			{ url: "https://publisher.example/broken.css", reason: "HTTP 404" },
		]);

		expect(cite.store.citation("https://publisher.example/partial-asset")).toMatchObject({
			status: "SAVED_PARTIAL",
		});

		expect(cite.store.search("Partial capture coverage")).toEqual([
			expect.objectContaining({ id: source.id, completeness: "PARTIAL" }),
		]);
	},
	30_000,
);

it.skipIf(!process.env["CITE_BROWSER_TESTS"])(
	"keeps a fully fetched page PRIMARY and COMPLETE with no missing assets",
	async () => {
		const page =
			'<!doctype html><html><head><title>Complete capture coverage</title><link rel="stylesheet" href="/style.css"></head><body><p>Primary source text long enough to clear the eighty character admission check comfortably for this page.</p></body></html>';
		const cite = setup((url) =>
			url.endsWith("robots.txt")
				? reply(url, "")
				: url.endsWith("style.css")
					? reply(url, "p{color:blue}", "text/css")
					: reply(url, page),
		);
		const result = await cite.add("https://publisher.example/complete-asset");
		const source = result.source;

		if (!source) {
			throw new Error("missing source");
		}

		expect(source.completeness).toBe("COMPLETE");
		expect(source.missing_assets).toEqual([]);

		expect(cite.store.citation("https://publisher.example/complete-asset")).toMatchObject({
			status: "SAVED",
		});

		expect(cite.store.search("Complete capture coverage")).toEqual([
			expect.objectContaining({ id: source.id, completeness: "COMPLETE" }),
		]);
	},
	30_000,
);

it.skipIf(!process.env["CITE_BROWSER_TESTS"])(
	"supersedes a partial save with a later refresh that fetches every asset",
	async () => {
		const page =
			'<!doctype html><html><head><title>Recapture coverage</title><link rel="stylesheet" href="/flaky.css"></head><body><p>Primary source text long enough to clear the eighty character admission check comfortably for this page.</p></body></html>';
		let assetAvailable = false;
		const cite = setup((url) =>
			url.endsWith("robots.txt")
				? reply(url, "")
				: url.endsWith("flaky.css")
					? assetAvailable
						? reply(url, "p{color:green}", "text/css")
						: failedAsset(url)
					: reply(url, page),
		);
		const ref = "https://publisher.example/recapture-asset";
		const first = await cite.add(ref);

		expect(first.source?.completeness).toBe("PARTIAL");

		assetAvailable = true;
		const second = await cite.add(ref, true);

		expect(second.source?.completeness).toBe("COMPLETE");
		expect(second.source?.missing_assets).toEqual([]);
		expect(second.source?.id).toBe(first.source?.id);
		expect(second.source?.previous_sha256).toBe(first.source?.sha256);
		expect(second.source?.previous_retrieval_id).toBe(first.source?.retrieval_id);
		expect(cite.store.history(ref)).toHaveLength(2);
		expect(cite.store.db.prepare("SELECT * FROM sources").all()).toHaveLength(1);
		expect(cite.store.citation(ref)).toMatchObject({ status: "SAVED" });
	},
	30_000,
);

it.skipIf(!process.env["CITE_BROWSER_TESTS"])(
	"requeues derivation and clears stale search text when a partial save is superseded",
	async (context) => {
		requireTools(context, ["pdfinfo", "pdftotext"]);

		const page =
			'<!doctype html><html><head><title>Rederive coverage</title><link rel="stylesheet" href="/flaky2.css"></head><body><p>Primary source text long enough to clear the eighty character admission check comfortably for this page.</p></body></html>';
		let assetAvailable = false;
		const cite = setup((url) =>
			url.endsWith("robots.txt")
				? reply(url, "")
				: url.endsWith("flaky2.css")
					? assetAvailable
						? reply(url, "p{color:teal}", "text/css")
						: failedAsset(url)
					: reply(url, page),
		);
		const ref = "https://publisher.example/rederive-asset";
		const first = await cite.add(ref);

		if (!first.source) {
			throw new Error("missing source");
		}

		expect(first.source.completeness).toBe("PARTIAL");
		expect((await cite.derive()).saved).toBe(1);
		expect(cite.store.derivation(first.source.id)).toMatchObject({ state: "SAVED" });

		expect(
			cite.store.db.prepare("SELECT text FROM evidence WHERE id=?").get(first.source.id),
		).not.toEqual({ text: "" });

		assetAvailable = true;
		const second = await cite.add(ref, true);

		if (!second.source) {
			throw new Error("missing upgraded source");
		}

		expect(second.source.id).toBe(first.source.id);
		expect(second.source.completeness).toBe("COMPLETE");

		// The upgrade must invalidate the stale derivation instead of leaving it pointed at the
		// partial capture's now-replaced DERIVED artifacts, and clear the text it had extracted.
		expect(cite.store.derivation(second.source.id)).toMatchObject({
			state: "PENDING",
			manifest: null,
		});

		expect(
			cite.store.db.prepare("SELECT text FROM evidence WHERE id=?").get(second.source.id),
		).toEqual({ text: "" });

		expect((await cite.derive()).saved).toBe(1);
		expect(cite.store.derivation(second.source.id)).toMatchObject({ state: "SAVED" });

		expect(
			cite.store.db.prepare("SELECT text FROM evidence WHERE id=?").get(second.source.id),
		).not.toEqual({ text: "" });
	},
	30_000,
);
