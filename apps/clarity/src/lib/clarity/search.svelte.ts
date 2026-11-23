// Clarity search store — the home↔searching↔results state machine, result
// cache, paginated infinite scroll, and the same-origin SearXNG fetch flow.
// Ported from the vanilla app.ts; the in-module globals (resultCache, curKey,
// category, timeRange) become a single runes store the components read.
//
// SAME-ORIGIN CONTRACT (must preserve): /search, /autocompleter, /config, /fx,
// /engines/* and image proxying all go browser → traefik → SearXNG directly.
// We only ever fetch RELATIVE paths here, so SvelteKit/adapter-node never
// proxies them — the browser hits the same origin and traefik routes them.

import { browser } from "$app/env";

import {
	calcAnswer,
	looksCalc,
	numbatAnswer,
	parseRecency,
	searchQueryString,
	urlFor,
	type Entry,
	type Result,
	type SearxConfig,
	type SearxResponse,
} from "./search-helpers";
import { settings } from "./settings.svelte";

export type State = "home" | "searching" | "results";

const SS = "clarity:";
const saveEntry = (key: string, e: Entry) => {
	if (!browser) return;

	try {
		sessionStorage.setItem(
			SS + key,
			JSON.stringify({
				q: e.q,
				cat: e.cat,
				priv: e.priv,
				results: e.results.slice(0, 260),
				page: e.page,
				n: e.n,
				exhausted: !!e.exhausted,
				scroll: e.scroll || 0,
			}),
		);
	} catch {
		/* quota */
	}
};

const loadEntry = (key: string): Entry | null => {
	if (!browser) return null;

	try {
		const s = sessionStorage.getItem(SS + key);

		return s ? JSON.parse(s) : null;
	} catch {
		return null;
	}
};

let _saveT: ReturnType<typeof setTimeout> | undefined;
const saveEntrySoon = (key: string, e: Entry) => {
	clearTimeout(_saveT);
	_saveT = setTimeout(() => saveEntry(key, e), 200);
};

export class SearchState {
	state = $state<State>("home");
	category = $state("general");
	timeRange = $state("");
	/** The current entry being shown (drives the results markup). */
	entry = $state<Entry | null>(null);
	/** Engine count for the home status line. */
	engineCount = $state<string>("—");
	errorHtml = $state("");
	scrolled = $state(false);
	/**
	 * The query/privacy of the ACTIVE search (set before results land — Claire streams in parallel
	 * with the result fetch, so entry alone is too late).
	 */
	activeQuery = $state("");
	activePriv = $state(false);
	/**
	 * Bumps on every point where the vanilla app called startClaire — the searching-state transition
	 * and each entry render. The page effect keys Claire on THIS (not on category/settings), so a
	 * category flip with an empty box or a live prefs toggle no longer re-triggers a stream: exactly
	 * the vanilla "Claire re-evaluates on each search render" semantics.
	 */
	renderSeq = $state(0);

	#cache = new Map<string, Entry>();
	#curKey = "";
	/** Injected transport (defaults to global fetch) — the SearXNG seam, mockable in tests. */
	#fetch: typeof fetch;

	constructor(fetchFn?: typeof fetch) {
		this.#fetch = fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
	}

	get curKey() {
		return this.#curKey;
	}

	/** One /search page (same-origin relative URL; browser → traefik → SearXNG). */
	#fetchPage(q: string, cat: string, priv: boolean, page: number): Promise<SearxResponse> {
		return this.#fetch("/search?" + searchQueryString(q, cat, priv, page, settings.current)).then(
			(r) => r.json() as Promise<SearxResponse>,
		);
	}

	setState(s: State) {
		this.state = s;

		if (s !== "results" && s !== "searching") this.scrolled = false;
	}

	async loadConfig() {
		try {
			const c = await this.#fetch("/config").then((r) => r.json() as Promise<SearxConfig>);
			const n = (c.engines || []).filter((e) => !e.disabled).length || (c.engines || []).length;

			if (n) this.engineCount = String(n);
		} catch {
			this.engineCount = "—";
		}
	}

	recent(): string[] {
		if (!browser) return [];

		try {
			return JSON.parse(localStorage.getItem("clarity-recent") || "[]");
		} catch {
			return [];
		}
	}
	pushRecent(q: string) {
		if (!browser || !settings.current.saveQueries) return;

		const r = this.recent().filter((x) => x !== q);

		r.unshift(q);

		try {
			localStorage.setItem("clarity-recent", JSON.stringify(r.slice(0, 8)));
		} catch {
			/* blocked */
		}
	}

	async autocomplete(q: string): Promise<string[]> {
		if (!settings.current.autocomplete) return [];

		try {
			const r = await this.#fetch("/autocompleter?q=" + encodeURIComponent(q));
			const data = await r.json();
			const list = Array.isArray(data) ? (Array.isArray(data[1]) ? data[1] : data) : [];

			return list.filter((x: unknown) => typeof x === "string").slice(0, 7);
		} catch {
			return [];
		}
	}

	// Numbat upgrade — async; fills the entry's numbat cache once it resolves and
	// reassigns `entry` so the AnswerCard re-derives (the reserved shell becomes
	// the real card, or falls back when the result is '').
	#maybeNumbat(e: Entry) {
		if (e.cat !== "general") return;

		const q = parseRecency(e.q).q.trim();

		if (!q || calcAnswer(q) !== null || !looksCalc(q)) return;

		if (e.numbat !== undefined) return;

		const key = this.#curKey;

		numbatAnswer(q).then((out) => {
			e.numbat = out ? out.replace(/\n\s*\n/g, "\n").trim() : "";

			if (this.#curKey !== key) return;

			this.entry = { ...e };
		});
	}

	#showEntry(e: Entry) {
		this.category = e.cat;
		this.timeRange = e.tr || "";
		this.entry = e;
		this.renderSeq++; // vanilla renderEntry → startClaire(e.q, e.cat, e.priv)
		this.#maybeNumbat(e);
	}

	/** The core search flow. Returns when page 1 is resolved (prefetch fires after). */
	async doSearch(opts: {
		query: string;
		priv?: boolean;
		fromHome: boolean;
		morph: (fn: () => void) => void;
		onPushState?: (url: string, data: unknown) => void;
		afterResults?: () => void;
	}): Promise<void> {
		const q = opts.query.trim();

		if (!q) return;

		this.timeRange = parseRecency(q).tr;
		this.pushRecent(q);
		const cat = this.category;
		const priv = !!opts.priv;
		const key = urlFor(q, cat, priv);

		opts.onPushState?.(key, { q, cat, priv });
		this.#curKey = key;
		this.activeQuery = q;
		this.activePriv = priv;
		const apply = (fn: () => void) => (opts.fromHome ? opts.morph(fn) : fn());

		let e = this.#cache.get(key) || loadEntry(key);

		if (e) {
			const ent = e;

			this.#cache.set(key, ent);

			apply(() => {
				this.#showEntry(ent);
				this.errorHtml = "";
				this.setState("results");
			});

			opts.afterResults?.();

			return;
		}

		apply(() => {
			this.errorHtml = "";
			this.entry = null;
			this.setState("searching");
			this.renderSeq++; // vanilla: startClaire fires right after the skeleton lands
		});

		const t0 = performance.now();
		let data: SearxResponse;

		try {
			data = await this.#fetchPage(q, cat, priv, 1);
		} catch (err) {
			data = { error: String(err) };
		}

		if (data.error) {
			this.errorHtml = String(data.error);
			this.entry = null;
			this.setState("results");

			return;
		}

		e = {
			q,
			cat,
			priv,
			tr: this.timeRange,
			ms: Math.round(performance.now() - t0),
			results: data.results || [],
			answers: (data.answers || [])
				.map((a) => (typeof a === "string" ? a : a?.answer || ""))
				.filter(Boolean)
				.slice(0, 3),
			page: 1,
			exhausted: !(data.results || []).length,
			n: data.number_of_results || (data.results || []).length,
			loading: false,
			scroll: 0,
		};

		this.#cache.set(key, e);
		saveEntry(key, e);
		this.#showEntry(e);
		this.setState("results");
		opts.afterResults?.();

		if (browser) requestAnimationFrame(() => this.loadMore());
	}

	/** Restore a cached entry for a key without re-fetching (back/forward). */
	restore(key: string): Entry | null {
		const e = this.#cache.get(key) || loadEntry(key);

		if (e) {
			this.#cache.set(key, e);
			this.#curKey = key;
			this.activeQuery = e.q;
			this.activePriv = e.priv;
			this.#showEntry(e);
			this.errorHtml = "";
			this.setState("results");
		}

		return e;
	}

	retry(rerun: () => void) {
		if (this.#curKey) this.#cache.delete(this.#curKey);

		rerun();
	}

	/** Infinite scroll — append the next page (web/videos only), deduped by url. */
	async loadMore(nearBottom?: () => boolean): Promise<Result[] | null> {
		const e = this.#cache.get(this.#curKey);

		if (
			!e ||
			e.loading ||
			e.exhausted ||
			!settings.current.infiniteScroll ||
			!["general", "videos"].includes(e.cat) ||
			this.state !== "results"
		)
			return null;

		e.loading = true;
		let data: SearxResponse;

		try {
			data = await this.#fetchPage(e.q, e.cat, e.priv, e.page + 1);
		} catch {
			e.loading = false;

			return null;
		}

		const have = new Set(e.results.map((r) => r.url));
		const fresh: Result[] = (data.results || []).filter((r: Result) => r.url && !have.has(r.url));

		if (!fresh.length) {
			e.exhausted = true;
			e.loading = false;

			return null;
		}

		e.page++;
		e.results.push(...fresh);
		// reassign so the component's $state sees the appended results
		this.entry = { ...e, results: e.results };
		this.#cache.set(this.#curKey, e);
		e.loading = false;
		saveEntrySoon(this.#curKey, e);

		if (e.page < 12 && nearBottom?.()) this.loadMore(nearBottom);

		return fresh;
	}

	saveScroll(y: number) {
		const e = this.#cache.get(this.#curKey);

		if (e) {
			e.scroll = y;
			saveEntrySoon(this.#curKey, e);
		}
	}
	saveScrollNow(y: number) {
		const e = this.#cache.get(this.#curKey);

		if (e) {
			e.scroll = y;
			saveEntry(this.#curKey, e);
		}
	}

	reset() {
		this.entry = null;
		this.errorHtml = "";
		this.#curKey = "";
		this.activeQuery = "";
		this.activePriv = false;
		this.renderSeq++; // vanilla goHome → claireHide; the page effect keys off this + state
		this.setState("home");
	}
}

export const search = new SearchState();
