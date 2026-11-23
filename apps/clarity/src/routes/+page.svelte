<script lang="ts">
	import { browser } from "$app/env";
	import { afterNavigate, goto } from "$app/navigation";
	import { page } from "$app/state";
	import { onMount, tick, untrack } from "svelte";

	import AnswerCard from "#lib/clarity/AnswerCard.svelte";
	import { safeHref } from "#lib/clarity/claire-protocol.ts";
	import Claire from "#lib/clarity/Claire.svelte";
	import { claire } from "#lib/clarity/claire.svelte.ts";
	import EgressIndicator from "#lib/clarity/EgressIndicator.svelte";
	import IconSprite from "#lib/clarity/IconSprite.svelte";
	import ImageTile from "#lib/clarity/ImageTile.svelte";
	import Preferences from "#lib/clarity/Preferences.svelte";
	import ResultRow from "#lib/clarity/ResultRow.svelte";
	import {
		calcAnswer,
		esc,
		loadNumbat,
		highlightQuery,
		host,
		liveSplit,
		looksCalc,
		numbatAnswer,
		parseRecency,
		TR_LABELS,
		type Result,
	} from "#lib/clarity/search-helpers.ts";
	import { search } from "#lib/clarity/search.svelte.ts";
	import { settings } from "#lib/clarity/settings.svelte.ts";
	import Skeletons from "#lib/clarity/Skeletons.svelte";
	import { theme } from "#lib/clarity/theme.svelte.ts";
	import VideoCard from "#lib/clarity/VideoCard.svelte";

	let { data }: { data?: { q: string; categories: string; priv: boolean } } = $props();

	// ---- local UI state (runes) ----
	// Init from the load data so the query SSRs into the box (shareable URL, and a
	// no-JS form submit lands here with the query pre-filled). The /preferences
	// and /about routes reuse this component without a load → data is undefined.
	// Intentionally captures only the INITIAL load value: the box SSRs the query,
	// then all later URL changes flow through syncFromURL()/afterNavigate, not this
	// prop. (svelte-ignore the state_referenced_locally hint — the capture is by design.)
	// svelte-ignore state_referenced_locally
	let query = $state(data?.q ?? "");
	let focused = $state(false);
	let kbdFocus = $state(false);
	let navOpen = $state(false);
	let menuOpen = $state(false);
	let menuRows = $state<{ q: string; src: string; hist: boolean }[]>([]);
	let menuSel = $state(-1);
	let liveHtml = $state(""); // live-calc bar contents (home only)
	let timeMenuOpen = $state(false);
	let prefsOpen = $state(false);
	let prefsSection = $state("general");

	let inputEl: HTMLInputElement;
	let hlInnerEl: HTMLDivElement | undefined;

	const cs = $derived(settings.current);
	const hasText = $derived(query.length > 0);
	const hlMarkup = $derived(highlightQuery(query));
	const recencyLabel = $derived(TR_LABELS[parseRecency(query).tr] || "Any time");

	// View Transitions support flag (sets html.has-vt; the CSS keys the morph off it)
	const supportsVT = () =>
		browser &&
		typeof document.startViewTransition === "function" &&
		!window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	function morph(fn: () => void) {
		if (!supportsVT()) {
			fn();

			return;
		}

		document.documentElement.classList.add("vt-active");
		const t = document.startViewTransition(fn);

		(t.finished || Promise.resolve()).finally(() => {
			document.documentElement.classList.remove("vt-active");
		});
	}

	const scrollEl = () => (document.scrollingElement || document.documentElement) as HTMLElement;
	const scrollY = () => scrollEl().scrollTop;
	const nearBottom = () =>
		scrollY() + window.innerHeight > scrollEl().scrollHeight - window.innerHeight * 1.5;

	// ---- syntax-highlight scroll sync ----
	function syncHLScroll() {
		if (hlInnerEl && inputEl) {
			hlInnerEl.style.transform = `translateX(${-inputEl.scrollLeft}px)`;
		}
	}

	// ---- recent + autocomplete menu ----
	let completeTimer: ReturnType<typeof setTimeout>;
	let lastCompletions: string[] = [];
	function openMenuFromState() {
		const q = query.trim();
		const rows: typeof menuRows = [];

		if (!q) {
			search
				.recent()
				.slice(0, 5)
				.forEach((r) => rows.push({ q: r, src: "recent", hist: true }));
		} else {
			lastCompletions.forEach((c) => rows.push({ q: c, src: "autocomplete", hist: false }));
		}

		menuRows = rows;
		menuSel = -1;
		menuOpen = rows.length > 0;
	}
	function scheduleComplete() {
		clearTimeout(completeTimer);
		const q = query.trim();

		if (!q) {
			lastCompletions = [];
			openMenuFromState();

			return;
		}

		if (!cs.autocomplete) {
			lastCompletions = [];

			return;
		}

		completeTimer = setTimeout(async () => {
			lastCompletions = await search.autocomplete(q);

			// a submit may have landed while the fetch was in flight — the menu must not
			// reopen over the results (vanilla parity, ba4f7c3): only reopen while the
			// input still has focus.
			if (document.activeElement !== inputEl) {
				return;
			}

			openMenuFromState();
		}, 130);
	}
	function closeMenu() {
		menuOpen = false;
		menuSel = -1;
	}
	function setMenuSel(i: number) {
		if (!menuRows.length) {
			menuSel = -1;

			return;
		}

		menuSel = (i + menuRows.length) % menuRows.length;

		void tick().then(() =>
			document.querySelector("#menu .row.sel")?.scrollIntoView({ block: "nearest" }),
		);
	}

	// ---- live calc (home only) ----
	let liveTimer: ReturnType<typeof setTimeout>;
	function liveCalc(): boolean {
		clearTimeout(liveTimer);

		if (search.state !== "home") {
			liveHtml = "";

			return false;
		}

		const q = parseRecency(query).q.trim();

		if (!q) {
			liveHtml = "";

			return false;
		}

		const instant = calcAnswer(q);

		if (instant === null && !looksCalc(q)) {
			liveHtml = "";

			return false;
		}

		if (instant !== null) {
			const v = Number(instant).toLocaleString(undefined, { maximumFractionDigits: 10 });

			liveHtml = `<span class="numbat-out lc-row"><span class="lc-in">${esc(q)}</span><span class="lc-out"><span class="numbat-operator">=</span> <span class="numbat-value">${v}</span></span></span>`;
		}

		liveTimer = setTimeout(async () => {
			const out = await numbatAnswer(q);

			if (parseRecency(query).q.trim() !== q || search.state !== "home") {
				return;
			}

			if (out) {
				liveHtml = liveSplit(out);
			} else if (instant === null) {
				liveHtml = "";
			}
		}, 160);

		return true;
	}

	// ---- input handlers ----
	function onInput() {
		syncHLScroll();

		if (liveCalc()) {
			closeMenu();
		} else {
			scheduleComplete();
		}
	}
	function onFocus() {
		focused = true;
		kbdFocus = true;
		openMenuFromState();
	}
	function onBlur() {
		setTimeout(() => {
			focused = false;
			kbdFocus = false;
			liveHtml = "";
		}, 120);
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			closeMenu();
			inputEl.blur();

			return;
		}

		if (!menuOpen || !menuRows.length) {
			return;
		}

		if (e.key === "ArrowDown") {
			e.preventDefault();
			setMenuSel(menuSel + 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setMenuSel(menuSel - 1);
		} else if (e.key === "Enter" && menuSel >= 0) {
			e.preventDefault();
			query = menuRows[menuSel].q;
			runSearch();
		}
	}
	function pickSuggestion(q: string) {
		query = q;
		runSearch();
	}
	function clearQuery() {
		query = "";
		liveHtml = "";
		menuRows = [];
		closeMenu();
		inputEl?.focus();
	}

	// ---- the search trigger ----
	function runSearch(priv = false, push = true) {
		const q = query.trim();

		if (!q) {
			inputEl?.focus();

			return;
		}

		clearTimeout(completeTimer); // a pending autocomplete must not reopen the menu over the results (ba4f7c3)
		closeMenu();
		inputEl?.blur();
		liveHtml = "";
		const fromHome = search.state === "home";

		search.doSearch({
			query: q,
			priv,
			fromHome,
			morph,
			// retry re-runs the same key — don't push a duplicate history entry (vanilla parity)
			...(push ? { onPushState: (url: string) => goto(url, { reset: false }) } : {}),
			afterResults: () => {
				if (browser) {
					requestAnimationFrame(() => {
						window.scrollTo(0, search.entry?.scroll || 0);
					});
				}
			},
		});
	}

	// ---- categories ----
	function pickCat(cat: string) {
		search.category = cat;

		if (search.state !== "home" && query.trim()) {
			runSearch();
		}
	}

	// ---- recency dropdown ----
	function setRecency(tr: string) {
		const base = parseRecency(query).q;

		query = (tr ? (base ? base + " past:" + tr : "past:" + tr) : base).trim();
		timeMenuOpen = false;

		if (parseRecency(query).q.trim()) {
			runSearch();
		} else {
			inputEl?.focus();
		}
	}

	// ---- home ----
	function goHome() {
		morph(() => {
			prefsOpen = false;
			document.documentElement.classList.remove("pf-open");
			search.reset();
		});

		query = "";
		closeMenu();
		goto("/", { reset: false });
		inputEl?.focus();
	}

	// ---- prefs routing ----
	function openPrefs(section: string | null) {
		if (section) {
			prefsSection = section;
		}

		prefsOpen = true;

		if (browser) {
			document.documentElement.classList.add("pf-open");
		}
	}
	function closePrefs() {
		// wrapped in a view transition so the logo morphs (vanilla prefs.ts parity)
		morph(() => {
			prefsOpen = false;

			if (browser) {
				document.documentElement.classList.remove("pf-open");
			}
		});

		const p = page.url.pathname;

		// Return to the ACTIVE search (not home) so a Preferences/About visit from a
		// results page keeps the results — vanilla overlaid prefs and never navigated,
		// so closing left the result set intact. curKey is a navigable /?q=… URL.
		if (p === "/preferences" || p === "/about") {
			const back = search.state !== "home" && search.curKey ? search.curKey : "/";

			goto(back, { reset: false });
		}
	}
	function navTo(e: MouseEvent, target: "preferences" | "about") {
		e.preventDefault();
		navOpen = false;

		morph(() => {
			openPrefs(target === "about" ? "about" : "general");
		});

		goto("/" + target, { reset: false });
	}

	// ---- infinite scroll + back-to-top + scrolled hairline ----
	let scrollTick = false;
	let toTopShow = $state(false);
	function onScroll() {
		if (scrollTick) {
			return;
		}

		scrollTick = true;

		requestAnimationFrame(() => {
			const y = scrollY();

			if (nearBottom()) {
				doLoadMore();
			}

			toTopShow = y > 350;
			search.scrolled = y > 8;
			search.saveScroll(y);
			scrollTick = false;
		});
	}
	async function doLoadMore() {
		const fresh = await search.loadMore(nearBottom);

		// entry reassigned inside loadMore → results-list reactively re-renders
		void fresh;
	}

	// ---- image lightbox (mobile) ----
	let lbOpen = $state(false);
	let lbImgs: Result[] = [];
	let lbIdx = $state(0);
	let lbSrc = $state("");
	// Show the (already-loaded) thumbnail immediately so the switch is INSTANT — no
	// lingering on the previous photo — then upgrade to full-res in the background
	// and swap in once it's decoded (only if still on this photo). Vanilla parity.
	function lbRender() {
		const r = lbImgs[lbIdx];

		if (!r) {
			return;
		}

		lbSrc = r.thumbnail || r.img_src || "";

		if (r.img_src && r.img_src !== r.thumbnail) {
			const full = new Image();

			full.referrerPolicy = "no-referrer";

			full.onload = () => {
				if (lbOpen && lbImgs[lbIdx] === r) {
					lbSrc = r.img_src!;
				}
			};

			full.src = r.img_src;
		}
	}
	const isMobileVP = () => browser && window.matchMedia("(max-width: 620px)").matches;
	function onListClick(e: MouseEvent) {
		const target = e.target as Element;

		// save scroll on any result link click (so back restores position)
		if (target.closest("a")) {
			search.saveScrollNow(scrollY());
		}

		if (!isMobileVP()) {
			return;
		}

		const tile = target.closest<HTMLElement>(".img-tile");

		if (!tile || search.entry?.cat !== "images") {
			return;
		}

		e.preventDefault();
		lbImgs = search.entry?.results || [];
		lbIdx = Number(tile.dataset.i);
		lbOpen = true;
		lbRender();
		document.documentElement.classList.add("lb-open");
	}
	function lbClose() {
		lbOpen = false;
		document.documentElement.classList.remove("lb-open");
	}
	function lbMove(d: number) {
		if (!lbImgs.length) {
			return;
		}

		lbIdx = (lbIdx + d + lbImgs.length) % lbImgs.length;
		lbRender();
	}
	const lbCur = $derived(lbImgs[lbIdx]);

	// ---- URL → state (initial load + back/forward) ----
	function syncFromURL() {
		const p = page.url.pathname;
		const params = page.url.searchParams;

		// prefs/about routes
		if (p === "/preferences") {
			openPrefs(prefsSection === "about" ? prefsSection : "general");

			return;
		}

		if (p === "/about") {
			openPrefs("about");

			return;
		}

		if (prefsOpen) {
			prefsOpen = false;

			if (browser) {
				document.documentElement.classList.remove("pf-open");
			}
		}

		const q = params.get("q");

		if (!q) {
			if (search.state !== "home") {
				query = "";
				search.reset();
			}

			return;
		}

		query = q;
		search.category = params.get("categories") || "general";
		const key = "/" + page.url.search;

		// Guard the runSearch→goto→afterNavigate loop: if this URL is already the
		// active search (runSearch set curKey before navigating), it's in-flight or
		// shown — don't re-fetch (that double-search left the page stuck on
		// "searching"). Only act on URLs we didn't initiate (direct load, back/fwd).
		if (key === search.curKey) {
			return;
		}

		// try cache first (back/forward restores exact set + the saved scroll offset —
		// the whole point of entry persistence: click a result, press Back, land on
		// the exact page AND position), else fetch.
		if (search.restore(key)) {
			requestAnimationFrame(() => {
				window.scrollTo(0, search.entry?.scroll || 0);
			});
		} else {
			document.documentElement.classList.add("no-anim");

			search
				.doSearch({
					query: q,
					priv: params.get("private") === "1",
					fromHome: false,
					morph: (fn) => fn(),
					afterResults: () =>
						requestAnimationFrame(() => {
							window.scrollTo(0, search.entry?.scroll || 0);
						}),
				})
				.finally(() =>
					requestAnimationFrame(() => {
						document.documentElement.classList.remove("no-anim");
					}),
				);
		}
	}

	// One-time imperative init — MUST be onMount, not $effect: settings.init()/
	// theme.init() write $state, and doing that inside a reactive $effect that
	// also (transitively) reads it loops (effect_update_depth_exceeded → breaks
	// hydration, so no bindings attach). onMount runs once, untracked.
	onMount(() => {
		if (supportsVT()) {
			document.documentElement.classList.add("has-vt");
		}

		document.documentElement.classList.add("hl-on");
		theme.init();
		settings.init();
		search.loadConfig();
		syncFromURL(); // initial URL → state (direct load of /?q=… or /preferences)
		const idle = window.requestIdleCallback || ((fn: () => void) => setTimeout(fn, 2000));

		idle(() => {
			void loadNumbat().catch(() => {
				/* The calculator can retry on input. */
			});
		});
	});

	// React to client navigation (link clicks, back/forward). afterNavigate fires
	// outside the reactive graph, so syncFromURL's state writes don't loop.
	afterNavigate(() => {
		if (browser) {
			syncFromURL();
		}
	});

	// Claire — the AI answer streams in parallel with the result fetch and restores
	// from its snapshot on back/refine. Vanilla called startClaire() at exactly two
	// points (doSearch right after the skeleton, and renderEntry) and claireHide()
	// from goHome/renderError. The store bumps `renderSeq` at those same points, so
	// this effect keys on renderSeq + state + errorHtml ONLY — query/category and the
	// aiAnswer/openNewTab settings are read UNTRACKED. That matches vanilla: a
	// category flip with an empty box or a live Preferences toggle does NOT
	// re-trigger a stream (it takes effect on the next actual search); claire.show()
	// stays idempotent per query, so the searching→results double-fire is a no-op.
	$effect(() => {
		void search.renderSeq; // trigger: a search rendered (searching, entry, or reset)
		const err = search.errorHtml;
		const state = search.state;

		if (!browser) {
			return;
		}

		untrack(() => {
			if (err || state === "home" || !search.activeQuery) {
				claire.hide();

				return;
			}

			claire.show(parseRecency(search.activeQuery).q, search.category, {
				enabled: settings.current.aiAnswer,
				newTab: settings.current.openNewTab,
				priv: search.activePriv,
			});
		});
	});

	function onDocClick(e: MouseEvent) {
		const t = e.target as Element;
		const sb = document.getElementById("searchbar");

		if (sb && !sb.contains(t)) {
			closeMenu();
		}

		if (navOpen && !t.closest("#navlinks") && !t.closest("#nav-menu-btn")) {
			navOpen = false;
		}

		if (timeMenuOpen && !t.closest("#r-time")) {
			timeMenuOpen = false;
		}
	}
	function onDocKeydown(e: KeyboardEvent) {
		if (!lbOpen) {
			return;
		}

		if (e.key === "Escape") {
			lbClose();
		} else if (e.key === "ArrowLeft") {
			lbMove(-1);
		} else if (e.key === "ArrowRight") {
			lbMove(1);
		}
	}
</script>

<svelte:head>
	<title>Clarity — search.</title>
	<meta name="description" content="A clean, privacy-forward metasearch front-end." />
	<link rel="preconnect" href="https://favicons.petalcat.dev" />
	<link
		rel="search"
		type="application/opensearchdescription+xml"
		title="Clarity"
		href="/opensearch.xml"
	/>
</svelte:head>

<svelte:window onscroll={onScroll} onclick={onDocClick} onkeydown={onDocKeydown} />

<IconSprite />

<div id="app" data-state={search.state} class:scrolled={search.scrolled} class:kbd-focus={kbdFocus}>
	<header class="topbar" id="topbar">
		<div class="status">
			<button class="mark-btn" aria-label="Home" onclick={goHome}
				><svg class="mark" viewBox="0 0 32 32"><use href="#i-mark" /></svg></button
			>
			<span class="dot"></span>
			<span class="meta"
				><span id="ecount">{search.engineCount}</span> engines<span class="logs">
					· 0 logs today</span
				></span
			>
			<EgressIndicator />
		</div>
		<nav class="topnav">
			<div class="navlinks" id="navlinks" class:open={navOpen}>
				<a
					href="/preferences"
					onclick={(e) => {
						navTo(e, "preferences");
					}}>Preferences</a
				>
				<a
					href="/about"
					onclick={(e) => {
						navTo(e, "about");
					}}>About</a
				>
				<a href="https://search.petalcat.dev" title="Switch to classic SearXNG">Classic UI</a>
			</div>
			<button
				class="icon-btn"
				id="theme-toggle"
				title="Toggle theme"
				aria-label="Toggle theme"
				onclick={() => theme.toggle()}
				><svg><use href={theme.resolved === "dark" ? "#i-sun" : "#i-moon"} /></svg></button
			>
			<button
				class="icon-btn nav-menu-btn"
				id="nav-menu-btn"
				title="Menu"
				aria-label="Menu"
				onclick={(e) => {
					e.stopPropagation();
					navOpen = !navOpen;
				}}><svg><use href="#i-menu" /></svg></button
			>
		</nav>
	</header>

	<button class="compact-logo" id="compact-logo" title="Home" aria-label="Home" onclick={goHome}
		><svg class="mark" viewBox="0 0 32 32"><use href="#i-mark" /></svg></button
	>

	<div class="brand" id="brand">
		<svg class="mark" viewBox="0 0 32 32"><use href="#i-mark" /></svg>
		<div class="wordmark">search.</div>
	</div>

	<div class="searchbar" id="searchbar">
		<!-- method=get/action=/ so a no-JS submit navigates to /?q=… (PE baseline);
		     the onsubmit handler preventDefaults + enhances when JS is on. -->
		<form
			class="pill"
			id="pill"
			class:focused
			class:has-text={hasText}
			method="get"
			action="/"
			autocomplete="off"
			onsubmit={(e) => {
				e.preventDefault();
				runSearch();
			}}
		>
			<svg class="search-icon"><use href="#i-search" /></svg>
			<div class="q-wrap">
				<div class="q-hl" id="q-hl" aria-hidden="true">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="q-hl-inner" bind:this={hlInnerEl}>{@html hlMarkup}</div>
				</div>
				<input
					id="q"
					name="q"
					bind:this={inputEl}
					bind:value={query}
					placeholder="Search the web, privately"
					aria-label="Search"
					spellcheck="false"
					autocapitalize="off"
					autocorrect="off"
					oninput={onInput}
					onfocus={onFocus}
					onblur={onBlur}
					onkeydown={onKeydown}
					onscroll={syncHLScroll}
				/>
			</div>
			<button type="button" class="pbtn" id="voice" title="Voice" aria-label="Voice search"
				><svg><use href="#i-mic" /></svg></button
			>
			<button
				type="button"
				class="pbtn"
				id="img"
				title="Search by image"
				aria-label="Search by image"><svg><use href="#i-image" /></svg></button
			>
			<button
				type="button"
				class="pbtn clear"
				id="clear"
				title="Clear"
				aria-label="Clear"
				onclick={clearQuery}><svg><use href="#i-x" /></svg></button
			>
			<button type="submit" class="pbtn pbtn-go" id="pill-go" title="Search" aria-label="Search"
				><svg><use href="#i-search" /></svg></button
			>
		</form>

		<div class="menu" id="menu" class:open={menuOpen} role="listbox" aria-label="Suggestions">
			{#each menuRows as row, i (row.src + row.q)}
				<div
					class="row"
					class:sel={i === menuSel}
					role="option"
					aria-selected={i === menuSel}
					tabindex="-1"
					onmousedown={(e) => {
						e.preventDefault();
						pickSuggestion(row.q);
					}}
				>
					<svg><use href={row.hist ? "#i-history" : "#i-search"} /></svg>
					<span class="q">{row.q}</span>
					<span class="src mono">{row.src}</span>
				</div>
			{/each}
			{#if menuRows.length}
				<div class="foot">
					<div class="vb"><span>↩ to search</span></div>
					<div class="hints mono">
						<span class="kbd">↑</span> <span class="kbd">↓</span> navigate
					</div>
				</div>
			{/if}
		</div>

		{#if liveHtml && search.state === "home"}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="live-calc" id="live-calc" aria-live="polite">{@html liveHtml}</div>
		{/if}
		<div class="shimmer" id="shimmer" aria-hidden="true"></div>
	</div>

	<div class="ctas" id="ctas">
		<button
			class="btn btn-primary"
			id="go"
			onclick={() => {
				runSearch();
			}}>Search</button
		>
		<button
			class="btn btn-ghost"
			id="private"
			title="Bias toward private, no-JS, non-tracking engines"
			onclick={() => {
				runSearch(true);
			}}><svg><use href="#i-shield" /></svg>I'm feeling private</button
		>
	</div>

	<div class="cats home-cats" id="cats">
		{#each [["general", "Web"], ["images", "Images"], ["videos", "Videos"]] as [cat, label] (cat)}
			<button
				class="chip"
				class:active={search.category === cat}
				onclick={() => {
					pickCat(cat);
				}}>{label}</button
			>
		{/each}
	</div>

	<div class="results-body" id="results-body">
		<div class="r-cats" id="r-cats">
			{#each [["general", "Web"], ["images", "Images"], ["videos", "Videos"]] as [cat, label] (cat)}
				<button
					class="chip"
					class:active={search.category === cat}
					onclick={() => {
						pickCat(cat);
					}}>{label}</button
				>
			{/each}
			<div class="r-time" id="r-time">
				<button
					class="r-time-btn"
					id="r-time-btn"
					aria-haspopup="true"
					aria-expanded={timeMenuOpen}
					title="Filter by recency"
					onclick={(e) => {
						e.stopPropagation();
						timeMenuOpen = !timeMenuOpen;
					}}><span class="r-time-label">{recencyLabel}</span><span class="r-caret">▾</span></button
				>
				{#if timeMenuOpen}
					<div class="r-time-menu" id="r-time-menu" role="menu">
						{#each [["", "Any time"], ["day", "Past day"], ["week", "Past week"], ["month", "Past month"], ["year", "Past year"]] as [tr, label] (tr)}
							<button
								role="menuitem"
								class:on={parseRecency(query).tr === tr}
								onclick={(e) => {
									e.stopPropagation();
									setRecency(tr);
								}}>{label}</button
							>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<Claire />

		<div id="r-answer">
			{#if search.entry && !search.errorHtml}
				<AnswerCard entry={search.entry} />
			{/if}
		</div>
		<div class="r-meta mono" id="r-meta">
			{#if search.entry}
				{#if search.entry.priv}<span class="r-priv">private</span> ·
				{/if}About {Number(search.entry.n).toLocaleString()} results for &ldquo;{search.entry
					.q}&rdquo;{#if search.entry.ms}
					<span class="r-time">· {search.entry.ms} ms</span>{/if}
			{/if}
		</div>
		<!-- delegation listener only (lightbox open + scroll-save); the real targets
		     inside are keyboard-accessible <a> elements, so no extra key handler -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="r-list" id="r-list" onclick={onListClick}>
			{#if search.errorHtml}
				<div class="r-empty">
					Search failed — {search.errorHtml}.
					<a
						href="#retry"
						class="r-retry"
						onclick={(e) => {
							e.preventDefault();

							search.retry(() => {
								runSearch(false, false);
							});
						}}>retry</a
					>
				</div>
			{:else if search.state === "searching"}
				<Skeletons cat={search.category} />
			{:else if search.entry}
				{#if search.entry.cat === "images"}
					{#if search.entry.results.length}
						<div class="img-grid" id="img-grid">
							{#each search.entry.results.slice(0, 120) as r, i (r.url + i)}
								<ImageTile result={r} index={i} openNewTab={cs.openNewTab} />
							{/each}
						</div>
					{:else}
						<div class="r-empty">No results matched &ldquo;{search.entry.q}&rdquo;.</div>
					{/if}
				{:else if search.entry.cat === "videos"}
					{#if search.entry.results.length}
						<div class="vid-grid" id="vid-grid">
							{#each search.entry.results as r, i (r.url + i)}
								<VideoCard result={r} openNewTab={cs.openNewTab} />
							{/each}
						</div>
					{:else}
						<div class="r-empty">No videos matched &ldquo;{search.entry.q}&rdquo;.</div>
					{/if}
				{:else if search.entry.results.length}
					{#each search.entry.results as r, i (r.url + i)}
						<ResultRow result={r} openNewTab={cs.openNewTab} />
					{/each}
				{:else}
					<div class="r-empty">
						No results matched &ldquo;{search.entry.q}&rdquo;.<br />Try fewer or different keywords.
					</div>
				{/if}
			{/if}
		</div>
	</div>

	<footer class="foot-bar" id="foot-bar">
		<span class="slug" id="slug">clarity.petalcat.dev · v0.1</span>
		<div class="links">
			<a href="https://github.com/searxng/searxng">Source</a>
			<a
				href="/about"
				onclick={(e) => {
					navTo(e, "about");
				}}>Status</a
			>
			<a
				href="/about"
				onclick={(e) => {
					navTo(e, "about");
				}}>Privacy</a
			>
			<a href="https://docs.searxng.org/donate.html">Donate</a>
		</div>
	</footer>

	<button
		class="to-top"
		id="to-top"
		class:show={toTopShow}
		title="Back to top"
		aria-label="Back to top"
		onclick={() => {
			window.scrollTo({ top: 0, behavior: "smooth" });
		}}><svg><use href="#i-up" /></svg></button
	>
</div>

{#if prefsOpen}
	<Preferences bind:section={prefsSection} onClose={closePrefs} />
{/if}

{#if lbOpen && lbCur}
	<div class="lb open" id="lb">
		<button class="lb-bg" aria-label="Close" onclick={lbClose}></button>
		<button class="lb-close" aria-label="Close" onclick={lbClose}
			><svg><use href="#i-x" /></svg></button
		>
		<button
			class="lb-prev"
			aria-label="Previous"
			onclick={() => {
				lbMove(-1);
			}}>‹</button
		>
		<button
			class="lb-next"
			aria-label="Next"
			onclick={() => {
				lbMove(1);
			}}>›</button
		>
		<div class="lb-stage">
			<img class="lb-img" referrerpolicy="no-referrer" alt="" src={lbSrc} />
			<div class="lb-cap">
				<div class="lb-title">{lbCur.title || host(lbCur.url)}</div>
				<a class="lb-link" href={safeHref(lbCur.url) ?? undefined} target="_blank" rel="noopener"
					>{host(lbCur.url)} ↗</a
				>
			</div>
		</div>
	</div>
{/if}

<style>
	/* the topbar logo button — strip default button chrome so the mark sits like the legacy <svg> */
	.mark-btn {
		display: inline-flex;
		padding: 0;
	}
</style>
