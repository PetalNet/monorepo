import { spawnSync } from "node:child_process";
/* oxlint-disable eslint/no-await-in-loop -- Sequential processing bounds resource use and preserves pacing, redirect and retry order. */
import { createHash } from "node:crypto";
import type * as fs from "node:fs";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Cite, Store } from "../src/index.ts";
import { PacingDeferred, normalize } from "../src/model.ts";
import { Network } from "../src/network.ts";
import type { Reply, Transport } from "../src/network.ts";
import { requireTools } from "./tools.ts";

const stores: Store[] = [];

function setup(transport: Transport) {
	const store = new Store(mkdtempSync(path.join(process.cwd(), ".cite-test-")));

	stores.push(store);

	return new Cite(store, new Network(store, transport, 0));
}

afterEach(() => {
	for (const store of stores.splice(0)) {
		store.close();
		rmSync(store.root, { recursive: true });
	}
});

const reply = (
	url: string,
	body: string | Buffer,
	status = 200,
	headers: Record<string, string> = {},
): Reply => ({ url, body: Buffer.from(body), status, headers });

function fixturePdf(title = "", author = "") {
	const stream = "BT /F1 18 Tf 20 80 Td (Deterministic primary evidence) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
		`<< /Title (${title}) /Author (${author}) /Subject () /Creator (Test converter) >>`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];

	objects.forEach((object, index) => {
		offsets.push(pdf.length);
		pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
	});

	const xref = pdf.length;

	pdf += `xref\n0 7\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("")}trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;

	return Buffer.from(pdf);
}

const pdfTransport: Transport = (url) =>
	url.endsWith("/robots.txt")
		? reply(url, "User-agent: *\nAllow: /\n")
		: reply(url, fixturePdf(), 200, { "content-type": "application/pdf" });

describe("capture and search", () => {
	it("saves hashed PDF, dated sidecar, note and an FTS hit; repeat is idempotent", async (context) => {
		requireTools(context, ["pdfinfo", "pdftotext"]);
		let requests = 0;
		const cite = setup(async (url) => {
			requests++;

			return pdfTransport(url);
		});
		const result = await cite.add("https://arxiv.org/abs/1706.03762v7");

		expect(result.counts.saved).toBe(1);
		const source = result.source;

		expect(source).toMatchObject({ title: "arxiv:1706.03762v7", authors: [] });

		if (!source) {
			return;
		}

		const artifact = source.artifacts[0];

		if (!artifact) {
			throw new Error("missing artifact");
		}

		expect(
			createHash("sha256")
				.update(readFileSync(path.join(cite.store.root, artifact.path)))
				.digest("hex"),
		).toBe(source.sha256);

		expect(
			JSON.parse(readFileSync(path.join(cite.store.root, `${artifact.path}.json`), "utf8")),
		).toMatchObject({
			access_status: "SAVED",
			source_type: "PRIMARY",
			fetched_at: source.fetched_at,
		});

		expect(readFileSync(path.join(cite.store.root, "notes", `${source.id}.md`), "utf8")).toContain(
			`source:: [[${source.id}]]`,
		);

		expect(cite.store.search("Deterministic")).toHaveLength(0);
		expect(cite.store.derivation(source.id)).toMatchObject({ state: "PENDING" });
		expect((await cite.derive()).saved).toBe(1);
		expect(cite.store.search("Deterministic")).toHaveLength(1);
		expect(statSync(cite.store.root).mode & 0o777).toBe(0o700);
		expect(statSync(path.join(cite.store.root, artifact.path)).mode & 0o777).toBe(0o600);
		const before = requests;

		expect((await cite.add("arxiv:1706.03762v7")).counts.processed).toBe(0);
		expect(requests).toBe(before);
	});

	it("never writes a memory when capture is inaccessible", async () => {
		const cite = setup((url) => reply(url, "", 403));

		await expect(cite.remember("claim", "1706.03762")).rejects.toThrow("not written");
		expect(cite.store.db.prepare("SELECT * FROM memories").all()).toHaveLength(0);
		expect(cite.store.job("arxiv:1706.03762")?.state).toBe("INACCESSIBLE");
	});

	it("captures before committing a memory and deduplicates the complete write", async () => {
		const cite = setup(pdfTransport);
		const first = await cite.remember("claim", "1706.03762");

		expect(await cite.remember("claim", "1706.03762")).toEqual(first);
		expect(cite.store.db.prepare("SELECT * FROM memories").all()).toHaveLength(1);
	});

	it("rejects HTML masquerading as an arXiv PDF", async () => {
		const cite = setup((url) =>
			url.endsWith("robots.txt") ? reply(url, "") : reply(url, "<html>Login required</html>"),
		);

		expect((await cite.add("1706.03762")).job?.state).toBe("INACCESSIBLE");
		expect(cite.store.search("Login")).toHaveLength(0);
	});

	it("requests Unpaywall using Janet's email and records closed-access papers", async () => {
		const urls: string[] = [];
		const cite = setup((url) => {
			urls.push(url);

			return reply(
				url,
				url.endsWith("robots.txt")
					? ""
					: JSON.stringify({ title: "Closed paper", best_oa_location: null }),
			);
		});
		const result = await cite.add("https://doi.org/10.1234/TEST");

		expect(result.job?.state).toBe("INACCESSIBLE");

		expect(
			urls.some(
				(url) =>
					new URL(url).searchParams.get("email") ===
					"291627965+returnsvoidjanet@users.noreply.github.com",
			),
		).toBe(true);
	});

	it("follows the OA PDF and indexes authoritative metadata", async () => {
		const cite = setup(async (url) => {
			if (
				new URL(url).hostname === "api.unpaywall.org" &&
				new URL(url).pathname.startsWith("/v2/")
			) {
				return reply(
					url,
					JSON.stringify({
						title: "OA primary",
						z_authors: [{ given: "A", family: "Researcher" }],
						best_oa_location: { url_for_pdf: "https://publisher.example/paper.pdf" },
					}),
				);
			}

			return pdfTransport(url);
		});
		const result = await cite.add("10.1234/example");

		expect(result.source).toMatchObject({
			title: "OA primary",
			authors: ["A Researcher"],
			canonical_id: "doi:10.1234/example",
		});
	});
});

describe("network policy and worker", () => {
	it("leaves an existing root's permissions alone", () => {
		const root = mkdtempSync(path.join(process.cwd(), ".cite-acl-"));

		chmodSync(root, 0o750);
		const store = new Store(root);

		stores.push(store);
		expect(statSync(root).mode & 0o777).toBe(0o750);
	});

	it("creates the index privately inside a traversable root and keeps an existing index's mode", () => {
		const root = mkdtempSync(path.join(process.cwd(), ".cite-acl-"));

		chmodSync(root, 0o755);
		const store = new Store(root);

		store.enqueue("arxiv:1706.03762");
		const database = path.join(root, "index-v2.sqlite");

		expect(statSync(database).mode & 0o777).toBe(0o600);
		expect(statSync(`${database}-wal`).mode & 0o777).toBe(0o600);
		store.close();
		chmodSync(database, 0o640);
		const reopened = new Store(root);

		stores.push(reopened);
		expect(statSync(database).mode & 0o777).toBe(0o640);
	});

	it("keeps the robots crawl delay when the all-host queue delays a request", async () => {
		const starts: { host: string; at: number }[] = [];
		const store = new Store(mkdtempSync(path.join(process.cwd(), ".cite-test-")));
		const hosts = ["two", "three", "four", "one", "one"];

		stores.push(store);

		for (const host of new Set(hosts)) {
			store.db
				.prepare("INSERT INTO robots VALUES(?,?,?)")
				.run(`https://${host}.example`, "User-agent: *\nCrawl-delay: 1\n", Date.now() + 60_000);
		}

		const network = new Network(
			store,
			(url) => {
				starts.push({ host: new URL(url).hostname, at: Date.now() });

				return reply(url, "page");
			},
			400,
		);

		// The first one.example request waits behind three other hosts in the all-host queue.
		await Promise.all(
			hosts.map((host, index) => network.get(`https://${host}.example/${String(index)}`)),
		);

		const one = starts.filter((entry) => entry.host === "one.example");

		expect(one).toHaveLength(2);
		expect((one[1]?.at ?? 0) - (one[0]?.at ?? 0)).toBeGreaterThanOrEqual(900);
	}, 20_000);

	it("does not hold other hosts behind a host that is still pacing", () => {
		const cite = setup(pdfTransport);

		cite.store.cooldown("slow.example", 20_000);
		const slow = cite.store.slot("slow.example", 3000, 400);
		const fast = cite.store.slot("fast.example", 3000, 400);

		expect(slow.reserved).toBe(false);
		expect(fast).toMatchObject({ reserved: true });
		expect(fast.at).toBeLessThan(Date.now() + 1000);
	});

	it("spaces requests across different hosts", async () => {
		const starts: number[] = [];
		const store = new Store(mkdtempSync(path.join(process.cwd(), ".cite-test-")));

		stores.push(store);

		const network = new Network(
			store,
			(url) => {
				starts.push(Date.now());

				return reply(url, url.endsWith("/robots.txt") ? "" : "page");
			},
			300,
		);

		await network.get("https://one.example/a");
		await network.get("https://two.example/b");
		const gaps = starts.slice(1).map((start, index) => start - (starts[index] ?? 0));

		expect(starts).toHaveLength(4);
		expect(Math.min(...gaps)).toBeGreaterThanOrEqual(150);
	});

	it.each([
		[422, true],
		[404, true],
		[403, false],
		[429, false],
	])("treats a robots HTTP %i as permitting capture: %s", async (status, permitted) => {
		const urls: string[] = [];
		const store = new Store(mkdtempSync(path.join(process.cwd(), ".cite-test-")));

		stores.push(store);

		const network = new Network(
			store,
			(url) => {
				urls.push(url);

				return url.endsWith("/robots.txt") ? reply(url, "{}", status) : reply(url, "page");
			},
			0,
		);
		const result = network.get("https://api.example/v2/item").then(
			(response) => response.status,
			(error: unknown) => (error instanceof Error ? error.message : "error"),
		);

		await (permitted
			? expect(result).resolves.toBe(200)
			: expect(result).resolves.toContain(`Robots unavailable (HTTP ${String(status)})`));

		expect(urls.includes("https://api.example/v2/item")).toBe(permitted);
	});

	it("parses an HTML robots page as having no rules", async () => {
		const urls: string[] = [];
		const store = new Store(mkdtempSync(path.join(process.cwd(), ".cite-test-")));

		stores.push(store);

		const network = new Network(
			store,
			(url) => {
				urls.push(url);

				return url.endsWith("/robots.txt")
					? reply(
							url,
							"<!DOCTYPE html><html><head><title>App</title></head><body></body></html>",
							200,
							{
								"content-type": "text/html",
							},
						)
					: reply(url, "page");
			},
			0,
		);

		await expect(network.get("https://spa.example/jobs/1")).resolves.toMatchObject({ status: 200 });
		expect(urls).toEqual(["https://spa.example/robots.txt", "https://spa.example/jobs/1"]);
	});

	it("fetches page assets six at a time per host instead of pacing them", async () => {
		let inFlight = 0;
		let peak = 0;
		const urls: string[] = [];
		const store = new Store(mkdtempSync(path.join(process.cwd(), ".cite-test-")));

		stores.push(store);

		const network = new Network(
			store,
			async (url) => {
				urls.push(url);
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 20));
				inFlight--;

				return reply(url, url.endsWith("/robots.txt") ? "" : "asset");
			},
			60_000,
		);
		const start = Date.now();

		await Promise.all(
			Array.from({ length: 18 }, (_, index) =>
				network.get(`https://cdn.example/${String(index)}.png`, true),
			),
		);

		expect(Date.now() - start).toBeLessThan(2000);
		expect(peak).toBe(6);
		expect(urls.filter((url) => url.endsWith("/robots.txt"))).toHaveLength(1);
	});

	it("holds assets for a cooldown shorter than the crawl delay", async () => {
		const urls: string[] = [];
		const store = new Store(mkdtempSync(path.join(process.cwd(), ".cite-test-")));

		stores.push(store);

		store.db
			.prepare("INSERT INTO robots VALUES(?,?,?)")
			.run("https://cdn.example", "User-agent: *\nCrawl-delay: 60\n", Date.now() + 60_000);

		const network = new Network(
			store,
			(url) => {
				urls.push(url);

				return reply(url, "", 429, { "retry-after": "31" });
			},
			3000,
		);

		await expect(network.get("https://cdn.example/a.png", true)).rejects.toThrow("Rate limited");

		await expect(network.get("https://cdn.example/b.png", true)).rejects.toBeInstanceOf(
			PacingDeferred,
		);

		expect(urls).toEqual(["https://cdn.example/a.png"]);
	});

	it("starts no asset inside the final paced interval of a cooldown", async () => {
		const starts: number[] = [];
		const store = new Store(mkdtempSync(path.join(process.cwd(), ".cite-test-")));

		stores.push(store);

		store.db
			.prepare("INSERT INTO robots VALUES(?,?,?)")
			.run("https://cdn.example", "", Date.now() + 60_000);

		store.cooldown("cdn.example", 500);
		const until = store.cooldownUntil("cdn.example");

		const network = new Network(
			store,
			(url) => {
				starts.push(Date.now());

				return reply(url, "asset");
			},
			3000,
		);

		await network.get("https://cdn.example/a.png", true);

		expect(starts).toHaveLength(1);
		expect(starts[0]).toBeGreaterThanOrEqual(until);
	});

	it("shares one failed robots fetch with concurrent assets", async () => {
		const urls: string[] = [];
		const store = new Store(mkdtempSync(path.join(process.cwd(), ".cite-test-")));

		stores.push(store);

		const network = new Network(
			store,
			async (url) => {
				urls.push(url);
				await new Promise((resolve) => setTimeout(resolve, 20));

				return reply(url, "", 500);
			},
			0,
		);
		const results = await Promise.allSettled(
			["a", "b", "c"].map((name) => network.get(`https://cdn.example/${name}.png`, true)),
		);

		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
		expect(urls).toEqual(["https://cdn.example/robots.txt"]);
	});

	it("starts no page asset on a host cooling down after an asset's 429", async () => {
		const urls: string[] = [];
		const store = new Store(mkdtempSync(path.join(process.cwd(), ".cite-test-")));

		stores.push(store);

		store.db
			.prepare("INSERT INTO robots VALUES(?,?,?)")
			.run("https://cdn.example", "", Date.now() + 60_000);

		const network = new Network(
			store,
			(url) => {
				urls.push(url);

				return reply(url, "", 429, { "retry-after": "120" });
			},
			3000,
		);

		await expect(network.get("https://cdn.example/a.png", true)).rejects.toThrow("Rate limited");

		await expect(network.get("https://cdn.example/b.png", true)).rejects.toBeInstanceOf(
			PacingDeferred,
		);

		expect(urls).toEqual(["https://cdn.example/a.png"]);
	});

	it("retries a GitHub-style 403 rate limit instead of recording it as restricted", async () => {
		const reset = Math.ceil(Date.now() / 1000) + 600;
		const cite = setup((url) =>
			url.endsWith("/robots.txt")
				? reply(url, "")
				: reply(url, "{}", 403, {
						"x-ratelimit-remaining": "0",
						"x-ratelimit-reset": String(reset),
					}),
		);
		const result = await cite.add("https://github.com/PetalNet/monorepo");

		expect(result.counts.retried).toBe(1);
		expect(result.job).toMatchObject({ state: "QUEUED", reason: "Rate limited (HTTP 403)" });
		expect(result.job?.next_at).toBeGreaterThanOrEqual(reset * 1000 - 1000);

		const cooldown = cite.store.db
			.prepare("SELECT next_at FROM domains WHERE host='api.github.com'")
			.get() as { next_at: number };

		expect(cooldown.next_at).toBeGreaterThanOrEqual(reset * 1000 - 1000);
	});

	it("denies robots-disallowed targets before fetching them", async () => {
		const urls: string[] = [];
		const cite = setup((url) => {
			urls.push(url);

			return reply(url, "User-agent: *\nDisallow: /\n");
		});

		expect((await cite.add("1706.03762")).job?.state).toBe("INACCESSIBLE");
		expect(urls).toEqual(["https://arxiv.org/robots.txt"]);
	});

	it("fails closed on unavailable robots and retries with backoff", async () => {
		const cite = setup((url) => reply(url, "", 503, { "retry-after": "120" }));
		const start = Date.now();
		const result = await cite.add("1706.03762");

		expect(result.counts.retried).toBe(1);
		expect(result.job?.next_at).toBeGreaterThanOrEqual(start + 120_000);
		expect((await cite.work()).processed).toBe(0);
	});

	it("checks the redirected domain's robots before fetching", async () => {
		const urls: string[] = [];
		const cite = setup((url) => {
			urls.push(url);

			if (url === "https://arxiv.org/robots.txt") {
				return reply(url, "");
			}

			if (url === "https://arxiv.org/pdf/1706.03762") {
				return reply(url, "", 302, { location: "https://blocked.example/paper.pdf" });
			}

			return reply(url, "User-agent: *\nDisallow: /\n");
		});

		expect((await cite.add("1706.03762")).job?.state).toBe("INACCESSIBLE");
		expect(urls).not.toContain("https://blocked.example/paper.pdf");
	});

	it("recovers an expired worker lease without stealing an active one", () => {
		const cite = setup(pdfTransport);

		cite.store.enqueue("arxiv:1706.03762");
		expect(cite.store.claim()).toBeDefined();
		expect(cite.store.claim()).toBeUndefined();
		cite.store.db.prepare("UPDATE jobs SET lease_until=0").run();
		expect(cite.store.claim()?.attempts).toBe(2);
	});

	it("bounds retries and reports failed counts", async () => {
		const cite = setup((url) => reply(url, "", 503));

		for (let i = 0; i < 4; i++) {
			cite.store.db.prepare("UPDATE jobs SET next_at=0").run();
			cite.store.db.prepare("UPDATE domains SET next_at=0").run();
			await cite.add("1706.03762");
		}

		expect(cite.store.job("arxiv:1706.03762")?.state).toBe("FAILED");
		expect(cite.store.job("arxiv:1706.03762")?.attempts).toBe(4);
	});

	it("reserves per-domain slots across store connections", () => {
		const cite = setup(pdfTransport);
		const other = new Store(cite.store.root);

		try {
			const first = cite.store.slot("example.org", 3000).at;

			expect(other.slot("example.org", 3000).at - first).toBeGreaterThanOrEqual(3000);
			expect(other.slot("different.org", 3000).at).toBeLessThan(first + 3000);
		} finally {
			other.close();
		}
	});

	it.each(["127.0.0.1", "10.10.10.14", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1"])(
		"refuses non-public IP %s",
		async (address) => {
			const cite = setup(pdfTransport);
			const host = address.includes(":") ? `[${address}]` : address;

			await expect(
				new Network(cite.store, undefined, 0).get(`http://${host}/source`),
			).rejects.toThrow("Non-public network destination refused");
		},
	);

	it.each([
		"https://user:pass@example.org",
		"https://example.org?access_token=secret",
		"file:///etc/passwd",
	])("rejects unsafe reference %s", (ref) => {
		expect(() => normalize(ref)).toThrow();
	});

	it("normalizes equivalent DOI and arXiv forms without losing versions", () => {
		expect(normalize("https://doi.org/10.1234/ABC")).toBe("doi:10.1234/abc");
		expect(normalize("https://arxiv.org/pdf/1706.03762v7.pdf")).toBe("arxiv:1706.03762v7");
		expect(normalize("hep-th/9901001v2")).toBe("arxiv:hep-th/9901001v2");
	});
});

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof fs>()),
	statfsSync: () => ({ bavail: 40 * 1024 ** 3, bsize: 1 }),
}));

it("the built-in fetch hook allows saved sources and denies unavailable ones", async () => {
	const cite = setup(pdfTransport);

	await cite.add("1706.03762");

	const invoke = (url: string) =>
		spawnSync(process.execPath, ["src/cli.ts", "hook"], {
			cwd: process.cwd(),
			input: JSON.stringify({ tool_name: "WebFetch", tool_input: { url } }),
			encoding: "utf8",
			env: { ...process.env, CITE_ROOT: cite.store.root },
		});
	const allowed = invoke("https://arxiv.org/abs/1706.03762");

	expect(allowed.status).toBe(0);

	expect(JSON.parse(allowed.stdout)).toMatchObject({
		hookSpecificOutput: { permissionDecision: "allow" },
	});

	cite.store.enqueue("arxiv:2307.03172");
	const job = cite.store.claim();

	if (!job) {
		throw new Error("missing job");
	}

	cite.store.finish(job, "INACCESSIBLE", "test access restriction");
	const denied = invoke("https://arxiv.org/abs/2307.03172");

	expect(JSON.parse(denied.stdout)).toMatchObject({
		hookSpecificOutput: { permissionDecision: "deny" },
	});

	const invalid = spawnSync(process.execPath, ["src/cli.ts", "hook"], {
		input: "{}",
		encoding: "utf8",
		env: { ...process.env, CITE_ROOT: cite.store.root },
	});

	expect(invalid.status).toBe(2);
});

it("uses arXiv citation metadata and saves the metadata artifact with the PDF", async () => {
	const cite = setup((url) =>
		url.includes("/abs/")
			? reply(
					url,
					'<html><head><meta content="A &amp; B" name="citation_title"><meta name="citation_author" content="Named author"></head></html>',
					200,
					{ "content-type": "text/html" },
				)
			: pdfTransport(url),
	);
	const result = await cite.add("1706.03762v7");

	expect(result.source).toMatchObject({
		title: "A & B",
		authors: ["Named author"],
		extractor: "http-original+arxiv-meta-v2",
	});

	expect(result.source?.artifacts.map((artifact) => artifact.mime)).toEqual([
		"application/pdf",
		"text/html",
	]);
});

it("preserves changed URL versions and deduplicates unchanged original bytes", async () => {
	let content = "First edition of durable original evidence";
	const cite = setup((url) =>
		reply(url, url.endsWith("robots.txt") ? "" : content, 200, {
			"content-type": "text/plain; charset=utf-8",
		}),
	);
	const ref = "https://publisher.example/evidence";
	const first = await cite.add(ref);

	content = "Second edition of durable original evidence";
	const second = await cite.add(ref, true);
	const repeated = await cite.add(ref, true);

	expect(first.source?.sha256).not.toBe(second.source?.sha256);
	expect(second.source?.previous_sha256).toBe(first.source?.sha256);
	expect(second.source?.previous_retrieval_id).toBe(first.source?.retrieval_id);
	expect(repeated.source?.sha256).toBe(second.source?.sha256);
	expect(repeated.source?.retrieval_id).not.toBe(second.source?.retrieval_id);
	expect(cite.store.history(ref)).toHaveLength(3);
	expect(cite.store.db.prepare("SELECT * FROM sources").all()).toHaveLength(2);

	expect(
		readFileSync(path.join(cite.store.root, first.source?.artifacts[0]?.path ?? ""), "utf8"),
	).toContain("First edition");

	expect((await cite.derive()).saved).toBe(2);
	expect(cite.store.search('"First edition"')).toHaveLength(1);
	expect(cite.store.search('"Second edition"')).toHaveLength(1);
});

it("records redirects and exact response headers without changing original bytes", async () => {
	const body = Buffer.from([0, 1, 2, 255, 13, 10]);
	const cite = setup((url) =>
		url.endsWith("robots.txt")
			? reply(url, "")
			: url.endsWith("/start")
				? reply(url, "", 302, { location: "https://cdn.example/data" })
				: reply(url, body, 200, { "content-type": "application/octet-stream; test=value" }),
	);
	const result = await cite.add("https://publisher.example/start");

	expect(result.source).toMatchObject({
		url: "https://publisher.example/start",
		final_url: "https://cdn.example/data",
		http_status: 200,
		content_type: "application/octet-stream; test=value",
	});

	const artifact = result.source?.artifacts[0];

	if (artifact?.role !== "ORIGINAL") {
		throw new Error("Missing original");
	}

	expect(artifact.retrieval.fetched_at).toMatch(/^\d{4}-/);
	expect(readFileSync(path.join(cite.store.root, artifact.path))).toEqual(body);
	expect((await cite.derive()).blocked).toBe(1);
	expect(cite.store.citation("https://publisher.example/start")).toMatchObject({ status: "SAVED" });

	expect(cite.store.derivation(result.source?.id ?? "")).toMatchObject({
		state: "BLOCKED",
		reason: "No supported text extractor for this original",
	});
});

it("reports citation status independently from internal worker states", async () => {
	const cite = setup((url) => reply(url, "", 403));

	cite.store.enqueue("https://publisher.example/pending");

	expect(cite.store.citation("https://publisher.example/pending")).toMatchObject({
		status: "PENDING",
		source_id: null,
	});

	await cite.add("1706.03762");

	expect(cite.store.citation("arxiv:1706.03762")).toMatchObject({
		status: "INACCESSIBLE",
		source_id: null,
	});

	const job = cite.store.claim("https://publisher.example/pending");

	if (!job) {
		throw new Error("Missing pending job");
	}

	cite.store.finish(job, "FAILED", "Permanent test failure");

	expect(cite.store.citation(job.ref)).toMatchObject({
		status: "BLOCKED",
		reason: "Permanent test failure",
		source_id: null,
	});

	expect(cite.store.db.prepare("SELECT * FROM citations WHERE status='SAVED'").all()).toHaveLength(
		0,
	);

	expect(cite.store.status().counts).toEqual([
		{ status: "BLOCKED", count: 1 },
		{ status: "INACCESSIBLE", count: 1 },
	]);
});

it("retains HTTP-encoded bytes while decoding only for derived search text", async () => {
	const data = gzipSync("Encoded original evidence survives byte for byte");
	const cite = setup((url) =>
		url.endsWith("robots.txt")
			? reply(url, "")
			: reply(url, data, 200, { "content-type": "text/plain", "content-encoding": "gzip" }),
	);
	const result = await cite.add("https://publisher.example/compressed");
	const artifact = result.source?.artifacts[0];

	expect(readFileSync(path.join(cite.store.root, artifact?.path ?? ""))).toEqual(data);
	expect(artifact).toMatchObject({ role: "ORIGINAL", retrieval: { content_encoding: "gzip" } });
	expect((await cite.derive()).saved).toBe(1);
	expect(cite.store.search("survives")).toHaveLength(1);
});

it("bounds queued extraction retries without losing a saved original", async () => {
	const cite = setup((url) =>
		url.endsWith("robots.txt")
			? reply(url, "")
			: reply(url, "%PDF-1.4\nBroken PDF", 200, { "content-type": "application/pdf" }),
	);
	const ref = "https://publisher.example/broken.pdf";
	const result = await cite.add(ref);

	for (let attempt = 0; attempt < 4; attempt++) {
		cite.store.db.prepare("UPDATE derivations SET next_at=0").run();
		await cite.derive();
	}

	expect(cite.store.citation(ref)).toMatchObject({ status: "SAVED" });

	expect(cite.store.derivation(result.source?.id ?? "")).toMatchObject({
		state: "BLOCKED",
		attempts: 4,
		reason: "Local extraction failed",
	});

	expect((await cite.add(ref)).counts.processed).toBe(0);
});

it.each([
	"https://arxiv.org.evil.example/abs/1706.03762",
	"https://fake-arxiv.org/abs/1706.03762",
	"https://doi.org.evil.example/10.1234/test",
	"https://example.org/arxiv.org/abs/1706.03762",
	"https://example.org/?source=https://doi.org/10.1234/test",
	"https://example.org/sci-hub.se",
	"https://example.org/?source=https://library.lol/",
	"https://not-sci-hub.example/",
])("does not treat URL substrings as source hostnames: %s", (ref) => {
	expect(normalize(ref)).toBe(new URL(ref).href);
});

it.each([
	"https://user:password@arxiv.org/abs/1706.03762",
	"https://arxiv.org/abs/1706.03762?access_token=secret",
	"https://doi.org/10.1234/test?api_key=secret",
])("validates the original URL before canonicalizing a trusted hostname: %s", (ref) => {
	expect(() => normalize(ref)).toThrow();
});

it.each([
	"https://sci-hub.se/",
	"https://www.sci-hub.se/",
	"https://libgen.is/",
	"https://annas-archive.org/",
	"https://library.lol/",
	"https://sub.library.lol/",
])("preserves exact DNS-label shadow-library exclusions: %s", (ref) => {
	expect(() => normalize(ref)).toThrow("Shadow-library source refused");
});

it("only dispatches the GitHub resolver for the exact parsed hostname", async () => {
	const urls: string[] = [];
	const cite = setup((url) => {
		urls.push(url);

		return reply(url, url.endsWith("robots.txt") ? "" : "Ordinary text evidence", 200, {
			"content-type": "text/plain",
		});
	});

	for (const ref of [
		"https://github.com.evil.example/owner/repo",
		"https://example.org/github.com/owner/repo",
		"https://github.com@other.example/owner/repo",
	]) {
		if (new URL(ref).username) {
			await expect(cite.add(ref)).rejects.toThrow("without credentials");
		} else {
			expect((await cite.add(ref)).source?.canonical_id).toBe(ref);
		}
	}

	expect(urls.some((url) => new URL(url).hostname === "api.github.com")).toBe(false);
});

describe("GitHub refs", () => {
	const sha = "a".repeat(40);
	const githubTransport =
		(urls: string[]): Transport =>
		(url) => {
			urls.push(url);

			if (url.endsWith("/robots.txt")) {
				return reply(url, "");
			}

			if (url.startsWith("https://api.github.com/")) {
				return reply(url, JSON.stringify({ sha }), 200, { "content-type": "application/json" });
			}

			if (url.startsWith("https://codeload.github.com/")) {
				return reply(url, gzipSync("archive"), 200, { "content-type": "application/x-gzip" });
			}

			return reply(url, `file at ${url}`, 200, { "content-type": "text/plain; charset=utf-8" });
		};

	it("pins a branch file URL to its current commit and keeps the dated resolution", async () => {
		const urls: string[] = [];
		const cite = setup(githubTransport(urls));
		const { source } = await cite.add("https://github.com/owner/repo/blob/main/docs/My%20Notes.md");

		expect(urls).toContain("https://api.github.com/repos/owner/repo/commits/main?per_page=1");

		expect(source).toMatchObject({
			canonical_id: `github:owner/repo@${sha}/docs/My Notes.md`,
			title: `owner/repo @ ${sha}/docs/My Notes.md (cited ref main)`,
			url: `https://raw.githubusercontent.com/owner/repo/${sha}/docs/My%20Notes.md`,
		});

		expect(
			source?.artifacts.map((artifact) => artifact.role === "ORIGINAL" && artifact.retrieval.url),
		).toEqual([
			`https://raw.githubusercontent.com/owner/repo/${sha}/docs/My%20Notes.md`,
			"https://api.github.com/repos/owner/repo/commits/main?per_page=1",
		]);
	});

	it("archives a nested branch tree at its current commit", async () => {
		const cite = setup(githubTransport([]));
		const { source } = await cite.add("https://github.com/owner/repo/tree/master/test/specs");

		expect(source).toMatchObject({
			canonical_id: `github:owner/repo@${sha}/test/specs`,
			mime: "application/gzip",
			url: `https://codeload.github.com/owner/repo/tar.gz/${sha}`,
		});

		expect(source?.artifacts).toHaveLength(2);
	});

	it.each([
		"https://github.com/colmap/colmap/issues/1358",
		"https://github.com/loro-dev/loro/releases/tag/loro-crdt%401.16.0",
		"https://github.com/kabouzeid",
	])("captures the non-code GitHub page %s as a page", async (ref) => {
		const urls: string[] = [];
		const cite = setup(githubTransport(urls));
		const { source } = await cite.add(ref);

		expect(source).toMatchObject({ canonical_id: ref, url: ref });
		expect(urls.some((url) => new URL(url).hostname === "api.github.com")).toBe(false);
	});

	it("records no moving ref for a commit permalink", async () => {
		const cite = setup(githubTransport([]));
		const { source } = await cite.add(
			`https://github.com/owner/repo/blob/${sha.slice(0, 7)}/a.txt`,
		);

		expect(source?.title).toBe(`owner/repo @ ${sha}/a.txt`);
		expect(source?.artifacts).toHaveLength(1);
	});
});

it("defers domain pacing without spending attempts and resumes multiple jobs after restart", async () => {
	let now = 1_800_000_000_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fetched: string[] = [];
	const transport: Transport = (url) => {
		fetched.push(url);

		return url.endsWith("robots.txt")
			? reply(url, "User-agent: *\nCrawl-delay: 120\n")
			: reply(url, `Original evidence from ${url}`, 200, { "content-type": "text/plain" });
	};

	const cite = setup(transport);

	try {
		expect((await cite.add("https://publisher.example/first")).source).toBeDefined();
		const second = "https://publisher.example/second";
		const third = "https://publisher.example/third";

		expect((await cite.add(second)).counts).toMatchObject({ deferred: 1, retried: 0, failed: 0 });
		expect((await cite.add(third)).counts.deferred).toBe(1);
		expect(cite.store.job(second)?.attempts).toBe(0);

		// Competing legitimate requests keep this job waiting beyond the ordinary retry budget.
		for (let i = 0; i < 6; i++) {
			now = cite.store.job(second)?.next_at ?? now;
			cite.store.cooldown("publisher.example", 120_000);
			const counts = await cite.work(second, 1);

			expect(counts).toMatchObject({ deferred: 1, retried: 0, failed: 0 });
			expect(cite.store.job(second)).toMatchObject({ state: "QUEUED", attempts: 0 });
		}

		const restarted = new Store(cite.store.root);

		try {
			const worker = new Cite(restarted, new Network(restarted, transport, 0));

			now = cite.store.job(second)?.next_at ?? now;
			expect((await worker.work(second, 1)).saved).toBe(1);
			expect((await worker.work(third, 1)).deferred).toBe(1);
			now = restarted.job(third)?.next_at ?? now;
			expect((await worker.work(third, 1)).saved).toBe(1);
			expect(restarted.job(second)?.attempts).toBe(1);
			expect(fetched.filter((url) => url.endsWith("robots.txt"))).toHaveLength(1);
			expect(fetched.filter((url) => url === second)).toHaveLength(1);
			expect(fetched.filter((url) => url === third)).toHaveLength(1);
		} finally {
			restarted.close();
		}
	} finally {
		clock.mockRestore();
	}
});

it("resumes a multi-request capture after pacing instead of fetching its first step again", async () => {
	let now = 1_800_000_000_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fetched: string[] = [];
	const transport: Transport = (url) => {
		fetched.push(url);

		if (url.endsWith("robots.txt")) {
			return reply(url, "User-agent: *\nCrawl-delay: 120\n");
		}

		if (new URL(url).pathname.startsWith("/abs/")) {
			return reply(url, '<meta name="citation_title" content="Checkpointed paper">', 200, {
				"content-type": "text/html",
			});
		}

		return reply(url, fixturePdf(), 200, { "content-type": "application/pdf" });
	};

	const cite = setup(transport);

	try {
		const first = await cite.add("1706.03762");

		expect(first.counts.deferred).toBe(1);
		expect(first.job?.attempts).toBe(0);
		now = first.job?.next_at ?? now;
		const restarted = new Store(cite.store.root);

		try {
			const worker = new Cite(restarted, new Network(restarted, transport, 0));
			const result = await worker.add("1706.03762");

			expect(result.source?.title).toBe("Checkpointed paper");
			expect(fetched.filter((url) => new URL(url).pathname.startsWith("/abs/"))).toHaveLength(1);
			expect(fetched.filter((url) => new URL(url).pathname.startsWith("/pdf/"))).toHaveLength(1);
			expect(restarted.db.prepare("SELECT * FROM request_cache").all()).toHaveLength(0);
		} finally {
			restarted.close();
		}
	} finally {
		clock.mockRestore();
	}
});

it("projects PDF title and invisible author metadata without altering original receipts", async (context) => {
	requireTools(context, ["pdfinfo", "pdftotext"]);
	const bytes = fixturePdf("Document Metadata Title", "Invisible Metadata Author");
	const cite = setup((url) =>
		url.endsWith("robots.txt")
			? reply(url, "")
			: reply(url, bytes, 200, { "content-type": "application/pdf" }),
	);
	const ref = "https://publisher.example/metadata.pdf";
	const result = await cite.add(ref);
	const source = result.source;

	if (!source) {
		throw new Error("Missing source");
	}

	const receiptPath = path.join(cite.store.root, `retrievals/${source.retrieval_id}.json`);
	const before = readFileSync(receiptPath);

	expect(source).toMatchObject({ title: ref, authors: [] });
	expect((await cite.derive()).saved).toBe(1);

	expect(cite.store.get(ref)).toMatchObject({
		title: "Document Metadata Title",
		authors: ["Invisible Metadata Author"],
	});

	expect(cite.store.get(source.id)?.title).toBe("Document Metadata Title");
	expect(cite.store.search('"Invisible Metadata Author"')).toHaveLength(1);

	expect(readFileSync(path.join(cite.store.root, `notes/${source.id}.md`), "utf8")).toContain(
		"Document Metadata Title",
	);

	expect(readFileSync(receiptPath)).toEqual(before);
	expect(readFileSync(path.join(cite.store.root, source.artifacts[0]?.path ?? ""))).toEqual(bytes);
});

describe.each(["direct", "doi"])("%s capture first", (first) => {
	it("keeps retrieval metadata isolated for shared PDF bytes", async (context) => {
		requireTools(context, ["pdfinfo", "pdftotext"]);
		const bytes = fixturePdf("Embedded Draft Title", "Draft Author");
		const direct = "https://publisher.example/shared.pdf";
		const doi = "doi:10.1234/shared";
		const cite = setup((url) => {
			if (new URL(url).pathname === "/robots.txt") {
				return reply(url, "");
			}

			if (new URL(url).hostname === "api.unpaywall.org") {
				return reply(
					url,
					JSON.stringify({
						title: "Published Title",
						z_authors: [{ given: "Published", family: "Author" }],
						best_oa_location: { url_for_pdf: direct },
					}),
				);
			}

			return reply(url, bytes, 200, { "content-type": "application/pdf" });
		});
		const initial = await cite.add(first === "direct" ? direct : doi);
		const receipt = initial.source;

		if (!receipt) {
			throw new Error("Missing source");
		}

		const receiptPath = path.join(cite.store.root, `retrievals/${receipt.retrieval_id}.json`);
		const before = readFileSync(receiptPath);

		expect((await cite.derive()).saved).toBe(1);
		await cite.add(first === "direct" ? doi : direct);

		expect(cite.store.get(doi)).toMatchObject({
			title: "Published Title",
			authors: ["Published Author"],
		});

		expect(cite.store.get(direct)).toMatchObject({
			title: "Embedded Draft Title",
			authors: ["Draft Author"],
		});

		expect(cite.store.get(doi)?.sha256).toBe(cite.store.get(direct)?.sha256);
		expect(readFileSync(receiptPath)).toEqual(before);

		expect(cite.store.history(doi)[0]).toMatchObject({
			title: "Published Title",
			authors: ["Published Author"],
		});

		expect(cite.store.history(direct)[0]).toMatchObject({ title: direct, authors: [] });

		cite.store.db
			.prepare("UPDATE source_projections SET metadata=? WHERE source_id=?")
			.run(
				JSON.stringify({ title: "Legacy merged title", authors: ["Legacy merged author"] }),
				receipt.id,
			);

		expect(cite.store.get(doi)).toMatchObject({
			title: "Published Title",
			authors: ["Published Author"],
		});

		expect(cite.store.get(direct)).toMatchObject({
			title: "Embedded Draft Title",
			authors: ["Draft Author"],
		});

		expect(readFileSync(receiptPath)).toEqual(before);
	});
});
