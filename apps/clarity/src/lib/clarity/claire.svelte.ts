/* Claire — the grounded, verified AI answer that streams in above the results.
   Pure client for the answer service’s /answer/stream SSE pipeline (retrieve → ground → rerank
   → generate → NLI verify-gate → abstain-by-default). This module changes NOTHING
   server-side: coalescing, the per-IP concurrency cap, rate limits and the answer
   cache all live in the answer service. fetch + manual SSE parse (not EventSource) so HTTP 429
   vs stream errors are distinguishable.

   Ported from the vanilla claire.ts: the imperative #claire DOM renders become this
   runes store + the Claire.svelte component. The wire protocol, snapshots and URL
   safety live in claire-protocol.ts; the transport is injected (constructor arg)
   so the whole state machine — backoff, abort epochs, snapshot restore isolation —
   is unit-testable with synthetic SSE streams. */

import {
	hasDom,
	ineligible,
	loadSnap,
	PHASE_LABELS,
	readSse,
	saveSnap,
	saveSnapMemory,
	sid,
	type ClaireOpts,
	type ClaireSentence,
	type ClaireSource,
	type Snap,
} from "./claire-protocol";

/** What the card is showing. 'hidden' = no card at all. */
export type ClaireMode =
	| "hidden"
	| "thinking"
	| "answer"
	| "abstain"
	| "consent"
	| "limited"
	| "error";

export class ClaireState {
	// ---- what the component renders ----
	mode = $state<ClaireMode>("hidden");
	streaming = $state(false);
	status = $state("");
	/** Route === 'local' — shield badge + no off-box favicon fetches. */
	isPrivate = $state(false);
	sentences = $state<ClaireSentence[]>([]);
	sources = $state<ClaireSource[]>([]);
	/** Stagger the source chips (first live emission only — not re-emits/restores) */
	sourcesStagger = $state(false);
	/** False on snapshot restore: no replayed sentence stagger (vanilla animation:none) */
	animate = $state(true);
	footShown = $state(false);
	metaShown = $state(false);
	dropped = $state(0);
	cached = $state(false);
	ms = $state(0);
	reason = $state("");
	message = $state("");
	errorDetail = $state("");
	newTab = $state(false);

	// ---- the state machine (module state in vanilla) ----
	readonly #fetch: typeof fetch;
	#ctl: AbortController | null = null;
	#epoch = 0; // bumped on every cancel; stale async callbacks check it and bail
	#curQ = ""; // query the card currently belongs to
	#renderedTerminal = ""; // '' | 'done' | 'abstain' | 'consent' | 'error' | 'limited' — stops restart loops

	constructor(fetchFn?: typeof fetch) {
		this.#fetch = fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
	}

	get curQ() {
		return this.#curQ;
	}

	#cancel(): void {
		this.#epoch++;

		if (this.#ctl) {
			this.#ctl.abort();
		}

		this.#ctl = null;
	}

	hide(): void {
		this.#cancel();
		this.#curQ = "";
		this.#renderedTerminal = "";
		this.mode = "hidden";
	}

	/** Entry point — called on every search render. Idempotent per query + state. */
	show(rawQ: string, cat: string, opts: ClaireOpts): void {
		const q = rawQ.trim();

		if (!opts.enabled || opts.priv || cat !== "general" || ineligible(q)) {
			this.hide();

			return;
		}

		this.newTab = opts.newTab;

		if (q === this.#curQ && (this.#ctl !== null || this.#renderedTerminal !== "")) {
			return;
		} // already streaming or terminally rendered

		const snap = loadSnap(q);

		this.#cancel();
		this.#curQ = q;
		this.#renderedTerminal = "";

		if (snap) {
			this.#renderSnap(snap);

			return;
		}

		void this.#start(q, false, 0);
	}

	/** The consent card's "Answer privately" button. */
	consentPrivately(): void {
		const q = this.#curQ;

		this.#cancel();
		this.#renderedTerminal = "";
		void this.#start(q, true, 0);
	}

	/** The error card's "Try again" button. */
	retry(): void {
		const q = this.#curQ;

		this.#cancel();
		this.#renderedTerminal = "";
		void this.#start(q, false, 0);
	}

	// ---- render-state transitions (the vanilla renderX() calls) ----

	#renderThinking(): void {
		this.mode = "thinking";
		this.sentences = [];
		this.sources = [];
		this.sourcesStagger = false;
		this.animate = true;
		this.footShown = false;
		this.metaShown = false;
		this.dropped = 0;
		this.cached = false;
		this.ms = 0;
		this.reason = "";
		this.message = "";
		this.errorDetail = "";
		this.isPrivate = false;
		this.streaming = true;
		this.status = "connecting";
	}

	#renderAbstain(message: string, reason: string): void {
		this.streaming = false;
		this.status = "";
		this.mode = "abstain";
		this.message = message;
		this.reason = reason;
	}

	#renderConsent(message: string): void {
		this.streaming = false;
		this.status = "";
		this.footShown = false;
		this.mode = "consent";
		this.message = message;
	}

	#renderLimited(): void {
		this.streaming = false;
		this.status = "";
		this.footShown = false;
		this.#renderedTerminal = "limited";
		this.#ctl = null;
		this.mode = "limited";
	}

	#renderError(detail: string): void {
		this.streaming = false;
		this.status = "";
		this.footShown = false;
		this.#renderedTerminal = "error";
		this.#ctl = null;
		this.mode = "error";
		this.errorDetail = detail;
	}

	#showSources(list: ClaireSource[], stagger: boolean): void {
		this.sources = list;
		this.sourcesStagger = stagger;
		this.footShown = true;
	}

	#renderSnap(snap: Snap): void {
		// a restore is a full repaint — never inherit the previous query's card
		this.#renderThinking();
		const local = snap.route === "local";

		this.streaming = false;
		this.isPrivate = local;
		this.status = "";
		this.#renderedTerminal = snap.state;

		if (snap.state === "consent") {
			this.#renderConsent(snap.message);

			return;
		}

		if (snap.state === "abstain" || snap.sentences.length === 0) {
			this.#renderAbstain(snap.message, snap.reason);

			if (snap.sources.length > 0) {
				this.#showSources(snap.sources, false);
			}

			return;
		}

		this.animate = false; // restore: no replayed stagger
		this.mode = "answer";
		this.sentences = snap.sentences;

		if (snap.sources.length > 0) {
			this.#showSources(snap.sources, false);
		}

		this.dropped = snap.dropped;
		this.cached = snap.cached;
		this.ms = snap.ms;
		this.metaShown = true;
		this.footShown = true;
	}

	// ---- the stream ----

	async #start(q: string, consent: boolean, attempt: number): Promise<void> {
		this.#epoch++;
		const my = this.#epoch;

		this.#ctl = new AbortController();
		this.#renderThinking();
		const t0 = performance.now();
		const url = `/answer/stream?q=${encodeURIComponent(q)}&session=${encodeURIComponent(
			sid(),
		)}${consent ? "&consent=1" : ""}`;

		let res: Response;

		try {
			res = await this.#fetch(url, {
				signal: this.#ctl.signal,
				headers: { Accept: "text/event-stream" },
			});
		} catch {
			if (my !== this.#epoch) {
				return;
			}

			this.#renderError("The answer service is unreachable.");

			return;
		}

		if (my !== this.#epoch) {
			return;
		}

		if (res.status === 429) {
			const body = (await res.json().catch(() => ({}))) as { retryAfterMs?: number };

			if (my !== this.#epoch) {
				return;
			}

			if (typeof body.retryAfterMs === "number" && attempt < 4) {
				// the concurrency-cap 429: a slot frees when an in-flight pipeline (~10s) ends.
				// Back off long enough to outlast one: 1.5s, 3s, 4.5s, 6s (≈15s total), then give up quietly.
				this.status = "waiting for a free slot";
				const wait = body.retryAfterMs + attempt * 1500;

				setTimeout(() => {
					if (my === this.#epoch && this.#curQ === q) {
						void this.#start(q, consent, attempt + 1);
					}
				}, wait);

				return;
			}

			this.#renderLimited();

			return;
		}

		if (res.status === 503) {
			// the answer service disabled: no card at all (search itself is unaffected)
			this.hide();

			return;
		}

		if (!res.ok || !res.body) {
			this.#renderError(`The answer service returned ${String(res.status)}.`);

			return;
		}

		const acc: Snap = {
			v: 1,
			state: "done",
			route: "cloud",
			sentences: [],
			sources: [],
			dropped: 0,
			cached: false,
			ms: 0,
			reason: "",
			message: "",
		};
		let terminal = false;
		let errored = false;

		const handle = (type: string, d: Record<string, unknown>): void => {
			switch (type) {
				case "meta": {
					const route = d.route === "local" ? "local" : "cloud";

					acc.route = route;
					this.isPrivate = route === "local";

					break;
				}
				case "status": {
					const phase = String(d.phase ?? "");

					if (phase === "cache-hit") {
						acc.cached = true;
					}

					if (acc.sentences.length === 0) {
						this.status = PHASE_LABELS[phase] ?? phase;
					}

					break;
				}
				case "sources": {
					const list = Array.isArray(d.sources) ? (d.sources as ClaireSource[]) : [];
					const first = acc.sources.length === 0 && list.length > 0;

					acc.sources = list;

					if (list.length > 0) {
						this.#showSources(list, first);
					}

					break;
				}
				case "sentence": {
					const s: ClaireSentence = {
						text: String(d.text ?? ""),
						cites: Array.isArray(d.cites) ? (d.cites as number[]) : [],
						entail: typeof d.entail === "number" ? d.entail : 0,
					};

					acc.sentences.push(s);
					this.mode = "answer";
					this.sentences = [...acc.sentences];
					this.status = "checking claims";

					break;
				}
				case "dropped":
					acc.dropped = typeof d.count === "number" ? d.count : 0;

					break;
				case "consent_required":
					acc.state = "consent";
					acc.message = String(d.message ?? "");
					this.#renderConsent(acc.message);

					break;
				case "abstain":
					acc.state = "abstain";
					acc.reason = String(d.reason ?? "");
					acc.message = String(d.message ?? "");
					this.#renderAbstain(acc.message, acc.reason);

					if (acc.sources.length > 0) {
						this.#showSources(acc.sources, false);
					}

					break;
				case "error":
					errored = true;
					terminal = true;
					this.#renderError(String(d.message ?? "The answer stream broke."));

					break;
				case "done": {
					terminal = true;
					acc.ms = Math.round(performance.now() - t0);
					this.streaming = false;
					this.status = "";

					if (acc.state === "done" && acc.sentences.length > 0) {
						this.dropped = acc.dropped;
						this.cached = acc.cached;
						this.ms = acc.ms;
						this.metaShown = true;
						this.footShown = true;
					}

					if (acc.state === "done" && acc.sentences.length === 0) {
						// defensive: done without sentences or abstain → treat as abstain
						acc.state = "abstain";
						this.#renderAbstain("", "");

						if (acc.sources.length > 0) {
							this.#showSources(acc.sources, false);
						}
					}

					this.#renderedTerminal = acc.state;

					// consent answers are session-specific; snapshot them only in memory, not sessionStorage
					if (!errored) {
						if (consent || !hasDom()) {
							saveSnapMemory(q, acc);
						} else {
							saveSnap(q, acc);
						}
					}

					break;
				}
			}
		};

		try {
			await readSse(
				res,
				() => my === this.#epoch,
				(type, d) => {
					if (my !== this.#epoch) {
						return;
					}

					handle(type, d);
				},
			);
		} catch {
			if (my !== this.#epoch) {
				return;
			}

			if (!terminal) {
				this.#renderError("The answer stream broke.");
			}

			return;
		}

		if (my !== this.#epoch) {
			return;
		}

		this.#ctl = null;

		if (!terminal) {
			this.#renderError("The answer stream ended early.");
		}
	}
}

export const claire = new ClaireState();
