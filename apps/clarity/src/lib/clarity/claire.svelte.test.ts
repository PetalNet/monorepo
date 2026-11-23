/* The Claire state machine driven through its injected transport with synthetic
   SSE streams — every 18d14a9 review finding and every terminal state becomes a
   regression test. No DOM: the store is pure runes state. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearSnaps } from "./claire-protocol";
import { ClaireState } from "./claire.svelte";

type MockRes = {
	status?: number;
	chunks?: string[];
	json?: unknown;
	hang?: boolean;
};

/** Build a fetch mock that serves the queued responses in order. */
function transport(queue: MockRes[]) {
	const calls: string[] = [];
	const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
		calls.push(String(input));
		const next = queue.shift() ?? { status: 500 };
		const status = next.status ?? 200;
		const enc = new TextEncoder();
		const body =
			next.chunks || next.hang
				? new ReadableStream<Uint8Array>({
						start(c) {
							for (const chunk of next.chunks ?? []) c.enqueue(enc.encode(chunk));

							if (!next.hang) c.close();
						},
					})
				: undefined;

		return {
			status,
			ok: status >= 200 && status < 300,
			body,
			json: async () => next.json ?? {},
		} as unknown as Response;
	});

	return { fetchFn, calls };
}

const OPTS = { enabled: true, newTab: false, priv: false };
const frame = (ev: string, data: object) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;

const FULL_STREAM = [
	frame("meta", { route: "cloud" }),
	frame("status", { phase: "retrieving" }),
	frame("sources", {
		sources: [
			{
				id: 1,
				url: "https://en.wikipedia.org/x",
				domain: "wikipedia.org",
				title: "X",
				fetched: true,
			},
		],
	}),
	frame("sentence", { text: "The sky is blue.", cites: [1], entail: 0.93 }),
	frame("dropped", { count: 2 }),
	frame("done", {}),
].join("");

const waitFor = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true));

beforeEach(() => clearSnaps());

describe("ClaireState", () => {
	it("sits out ineligible/private/non-general searches (hidden, no fetch)", () => {
		const { fetchFn } = transport([]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("2+2", "general", OPTS);
		c.show("why is the sky blue", "images", OPTS);
		c.show("why is the sky blue", "general", { ...OPTS, priv: true });
		c.show("why is the sky blue", "general", { ...OPTS, enabled: false });
		expect(c.mode).toBe("hidden");
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("streams a full answer: sentences, sources, meta, terminal done", async () => {
		const { fetchFn, calls } = transport([{ chunks: [FULL_STREAM] }]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		expect(c.mode).toBe("thinking");
		expect(c.streaming).toBe(true);
		await waitFor(() => c.mode === "answer" && !c.streaming);
		expect(calls[0]).toContain("/answer/stream?q=why%20is%20the%20sky%20blue");
		expect(c.sentences).toEqual([{ text: "The sky is blue.", cites: [1], entail: 0.93 }]);
		expect(c.sources[0]!.domain).toBe("wikipedia.org");
		expect(c.dropped).toBe(2);
		expect(c.metaShown).toBe(true);
		expect(c.footShown).toBe(true);
		expect(c.status).toBe("");
	});

	it("is idempotent per query — a re-render never re-fetches a terminal answer", async () => {
		const { fetchFn } = transport([{ chunks: [FULL_STREAM] }]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c.mode === "answer");
		c.show("why is the sky blue", "general", OPTS);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("restores a new instance from the snapshot without spending quota, fully repainted", async () => {
		const t1 = transport([{ chunks: [FULL_STREAM] }]);
		const c1 = new ClaireState(t1.fetchFn as unknown as typeof fetch);

		c1.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c1.mode === "answer");

		const t2 = transport([]);
		const c2 = new ClaireState(t2.fetchFn as unknown as typeof fetch);

		c2.show("why is the sky blue", "general", OPTS);
		expect(t2.fetchFn).not.toHaveBeenCalled();
		expect(c2.mode).toBe("answer");
		expect(c2.animate).toBe(false); // restore: no replayed stagger
		expect(c2.sentences).toHaveLength(1);
		expect(c2.metaShown).toBe(true);
	});

	it("switching to a new query mid-stream aborts the old epoch (no bleed-through)", async () => {
		const { fetchFn } = transport([
			{ hang: true, chunks: [frame("sentence", { text: "OLD.", cites: [], entail: 0 })] },
			{ chunks: [FULL_STREAM] },
		]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("first question here", "general", OPTS);
		await waitFor(() => c.sentences.length === 1);
		c.show("second question here", "general", OPTS);
		expect(c.mode).toBe("thinking"); // full repaint, OLD. gone
		expect(c.sentences).toHaveLength(0);
		await waitFor(() => c.mode === "answer");
		expect(c.sentences[0]!.text).toBe("The sky is blue.");
	});

	it("429 with retryAfterMs backs off and retries to success", async () => {
		const { fetchFn } = transport([
			{ status: 429, json: { retryAfterMs: 0 } },
			{ chunks: [FULL_STREAM] },
		]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c.mode === "answer");
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("429 gives up after 4 retries and goes limited (no infinite retry)", async () => {
		vi.useFakeTimers();

		try {
			const { fetchFn } = transport(
				Array.from({ length: 6 }, () => ({ status: 429, json: { retryAfterMs: 1 } })),
			);
			const c = new ClaireState(fetchFn as unknown as typeof fetch);

			c.show("why is the sky blue", "general", OPTS);
			await vi.runAllTimersAsync();
			expect(c.mode).toBe("limited");
			expect(fetchFn).toHaveBeenCalledTimes(5); // attempts 0..3 retry, attempt 4 gives up
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-showing the same query after a terminal limited/error is idempotent", async () => {
		const { fetchFn } = transport([{ status: 429, json: {} }]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c.mode === "limited");
		c.show("why is the sky blue", "general", OPTS); // terminal → no restart
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(c.mode).toBe("limited");
	});

	it("429 without retryAfterMs goes quietly limited", async () => {
		const { fetchFn } = transport([{ status: 429, json: {} }]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c.mode === "limited");
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("503 hides the card entirely (answerd disabled)", async () => {
		const { fetchFn } = transport([{ status: 503 }]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c.mode === "hidden");
	});

	it("error event renders the error state and retry() restarts the stream", async () => {
		const { fetchFn } = transport([
			{ chunks: [frame("error", { message: "The pipeline exploded." })] },
			{ chunks: [FULL_STREAM] },
		]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c.mode === "error");
		expect(c.errorDetail).toBe("The pipeline exploded.");
		c.retry();
		await waitFor(() => c.mode === "answer");
	});

	it("an errored stream is never snapshotted (no cached error on back/refine)", async () => {
		const { fetchFn } = transport([
			{ chunks: [frame("error", { message: "boom" }) + frame("done", {})] },
		]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		// error then done: the defensive done-branch settles on abstain (vanilla semantics)
		await waitFor(() => c.mode === "abstain");
		const t2 = transport([{ chunks: [FULL_STREAM] }]);
		const c2 = new ClaireState(t2.fetchFn as unknown as typeof fetch);

		c2.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c2.mode === "answer"); // fetched fresh, not restored from an error snap
		expect(t2.fetchFn).toHaveBeenCalledTimes(1);
	});

	it("abstain renders the quiet no-answer state with reason tag", async () => {
		const { fetchFn } = transport([
			{
				chunks: [
					frame("abstain", { reason: "low-entailment", message: "Nothing cleared the bar." }) +
						frame("done", {}),
				],
			},
		]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c.mode === "abstain");
		expect(c.reason).toBe("low-entailment");
		expect(c.message).toBe("Nothing cleared the bar.");
	});

	it("done without any sentence is a defensive abstain", async () => {
		const { fetchFn } = transport([{ chunks: [frame("done", {})] }]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c.mode === "abstain");
	});

	it('a stream that ends without done is an "ended early" error', async () => {
		const { fetchFn } = transport([{ chunks: [frame("status", { phase: "generating" })] }]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c.mode === "error");
		expect(c.errorDetail).toContain("ended early");
	});

	it("consent_required gates the answer; consentPrivately() re-asks with consent=1", async () => {
		const { fetchFn, calls } = transport([
			{
				chunks: [
					frame("consent_required", { message: "This looks sensitive." }) + frame("done", {}),
				],
			},
			{
				chunks: [
					frame("meta", { route: "local" }) +
						FULL_STREAM.replace(frame("meta", { route: "cloud" }), ""),
				],
			},
		]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("personal health question", "general", OPTS);
		await waitFor(() => c.mode === "consent");
		expect(c.message).toBe("This looks sensitive.");
		c.consentPrivately();
		await waitFor(() => c.mode === "answer");
		expect(calls[1]).toContain("consent=1");
		expect(c.isPrivate).toBe(true); // local route → shield, no off-box favicons
	});

	it("hide() aborts and clears mid-stream", async () => {
		const { fetchFn } = transport([
			{ hang: true, chunks: [frame("status", { phase: "retrieving" })] },
		]);
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c.status === "searching");
		c.hide();
		expect(c.mode).toBe("hidden");
	});

	it("unreachable service renders the unreachable error", async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		const c = new ClaireState(fetchFn as unknown as typeof fetch);

		c.show("why is the sky blue", "general", OPTS);
		await waitFor(() => c.mode === "error");
		expect(c.errorDetail).toContain("unreachable");
	});
});
