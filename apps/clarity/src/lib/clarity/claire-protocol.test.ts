import { describe, expect, it } from "vitest";

import {
	clearSnaps,
	ineligible,
	loadSnap,
	readSse,
	safeHref,
	saveSnapMemory,
	type Snap,
} from "./claire-protocol";

describe("safeHref — 18d14a9 regression: only http(s) may become a link", () => {
	it("passes http and https through", () => {
		expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
		expect(safeHref("http://example.com")).toBe("http://example.com");
	});

	const scriptScheme = "javascript";

	it.each([
		`${scriptScheme}:alert(1)`,
		"data:text/html,<script>1</script>",
		"vbscript:x",
		"file:///etc/passwd",
	])("kills %s", (u) => {
		expect(safeHref(u)).toBeNull();
	});

	it("kills unparsable URLs", () => {
		expect(safeHref("not a url")).toBeNull();
		expect(safeHref("")).toBeNull();
	});
});

describe("ineligible — the calculator/bang carve-outs", () => {
	it("rejects short queries", () => {
		expect(ineligible("ab")).toBe(true);
	});

	it("rejects bangs (they redirect)", () => {
		expect(ineligible("!g cats")).toBe(true);
		expect(ineligible("search !!w thing")).toBe(true);
	});

	it("rejects arithmetic-adjacent queries (the calc card owns them)", () => {
		expect(ineligible("2+2")).toBe(true);
		expect(ineligible("7 * 6")).toBe(true);
	});

	it("rejects unit conversions (Numbat owns them)", () => {
		expect(ineligible("3 km to miles")).toBe(true);
	});

	it("accepts a normal question", () => {
		expect(ineligible("why is the sky blue")).toBe(false);
	});
});

describe("snapshots", () => {
	it("memory snapshots round-trip without sessionStorage", () => {
		clearSnaps();

		const s: Snap = {
			v: 1,
			state: "done",
			route: "cloud",
			sentences: [{ text: "A fact.", cites: [1], entail: 0.9 }],
			sources: [],
			dropped: 0,
			cached: false,
			ms: 1200,
			reason: "",
			message: "",
		};

		saveSnapMemory("q1", s);
		expect(loadSnap("q1")).toEqual(s);
		expect(loadSnap("other")).toBeNull();
		clearSnaps();
		expect(loadSnap("q1")).toBeNull();
	});
});

/** Build a Response whose body streams the given chunks. */
function sseResponse(chunks: string[]): Response {
	const enc = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			for (const chunk of chunks) {
				c.enqueue(enc.encode(chunk));
			}

			c.close();
		},
	});

	return { body } as unknown as Response;
}

describe("readSse", () => {
	it("parses typed events and JSON payloads", async () => {
		const got: [string, unknown][] = [];

		await readSse(
			sseResponse(['event: status\ndata: {"phase":"retrieving"}\n\nevent: done\ndata: {}\n\n']),
			() => true,
			(t, d) => got.push([t, d]),
		);

		expect(got).toEqual([
			["status", { phase: "retrieving" }],
			["done", {}],
		]);
	});

	it("reassembles frames split across arbitrary chunk boundaries", async () => {
		const frame = 'event: sentence\ndata: {"text":"hello world","cites":[1],"entail":0.8}\n\n';
		const got: [string, unknown][] = [];

		await readSse(
			sseResponse([frame.slice(0, 13), frame.slice(13, 40), frame.slice(40)]),
			() => true,
			(t, d) => got.push([t, d]),
		);

		expect(got).toEqual([["sentence", { text: "hello world", cites: [1], entail: 0.8 }]]);
	});

	it("skips keepalive comments and malformed JSON without dying", async () => {
		const got: string[] = [];

		await readSse(
			sseResponse([": keepalive\n\nevent: x\ndata: {broken\n\nevent: done\ndata: {}\n\n"]),
			() => true,
			(t) => got.push(t),
		);

		expect(got).toEqual(["done"]);
	});

	it("defaults the event type to message", async () => {
		const got: string[] = [];

		await readSse(
			sseResponse(['data: {"a":1}\n\n']),
			() => true,
			(t) => got.push(t),
		);

		expect(got).toEqual(["message"]);
	});

	it("bails as soon as the epoch moves on", async () => {
		let current = true;
		const got: string[] = [];

		await readSse(
			sseResponse(["event: a\ndata: {}\n\n", "event: b\ndata: {}\n\n"]),
			() => current,
			(t) => {
				got.push(t);
				current = false; // cancel after the first event's chunk
			},
		);

		expect(got).toEqual(["a"]);
	});
});
