<!--
	Clarity preferences overlay (#pf) — ported from the vanilla prefs.ts. The
	innerHTML-string sections become declarative Svelte markup; the data-k/data-v
	delegation becomes direct bindings onto the `settings` runes store. Theme uses
	the `theme` store (replacing the window.* setTheme/getTheme bridge).

	Progressive enhancement: this overlay is the JS-enhanced editor. The route
	page (+page.svelte for /preferences) also renders a static, no-JS form so the
	settings page is meaningful without hydration.
-->
<script lang="ts">
	import { browser } from "$app/env";

	import { type SearxConfig } from "./search-helpers";
	import { settings } from "./settings.svelte";
	import { theme, type ThemePref } from "./theme.svelte";

	let { section = $bindable("general"), onClose }: { section?: string; onClose: () => void } =
		$props();

	interface Engine {
		name: string;
		cats: string[];
	}
	let engines = $state<Engine[]>([]);

	$effect(() => {
		if (!browser) {
			return;
		}

		fetch("/config")
			.then((r) => r.json() as Promise<SearxConfig>)
			.then((c) => {
				engines = (c.engines || [])
					.filter((e) => !e.disabled)
					.map((e) => ({ name: e.name, cats: e.categories || [] }));
			})
			.catch(() => {
				/* Engine preferences remain usable without the backend list. */
			});
	});

	const SECTIONS = [
		["general", "General", "i-search"],
		["appearance", "Appearance", "i-sun"],
		["privacy", "Privacy", "i-shield"],
		["engines", "Engines", "i-menu"],
		["hotkeys", "Hotkeys", "i-up"],
		["about", "About", "i-mark"],
	] as const;

	const ACCENTS = ["", "#2A6FDB", "#1F8A5B", "#D97757", "#6B47C7", "#E94545"];
	const HOTKEYS: [string, string][] = [
		["/", "Focus the search bar"],
		["Esc", "Close suggestions"],
		["Enter", "Search"],
		["↑ / ↓", "Navigate suggestions"],
		["!g, !w, !yt …", "Bang shortcuts → jump straight to an engine"],
		["past:week", "Recency filter inline — past day / week / month / year"],
		['site: filetype: -word "…"', "Operators highlight as you type"],
	];

	const cs = $derived(settings.current);

	function toggleEngine(name: string) {
		const off = cs.disabledEngines.includes(name);
		const next = off ? cs.disabledEngines.filter((x) => x !== name) : [...cs.disabledEngines, name];

		settings.set("disabledEngines", next);
	}
	const engineOn = (name: string) => !cs.disabledEngines.includes(name);
</script>

<div id="pf">
	<header class="pf-head">
		<button class="pf-logo" onclick={onClose}
			><svg class="mark"><use href="#i-mark" /></svg><span>search.</span></button
		>
		<div class="pf-title">Preferences</div>
		<button class="pf-done" onclick={onClose}>Done</button>
	</header>
	<div class="pf-body">
		<nav class="pf-nav">
			{#each SECTIONS as [key, label, icon] (key)}
				<button class="pf-nav-i" class:on={key === section} onclick={() => (section = key)}
					><svg><use href={"#" + icon} /></svg>{label}</button
				>
			{/each}
		</nav>
		<div class="pf-content">
			{#if section === "general"}
				<div class="pf-card">
					<div class="pf-card-h mono">General</div>
					<div class="pf-row">
						<div class="pf-label">
							Safe search
							<div class="pf-hint">Filter explicit results</div>
						</div>
						<div class="pf-ctrl">
							<div class="pf-seg">
								{#each [["off", "Off"], ["moderate", "Moderate"], ["strict", "Strict"]] as [v, l] (v)}
									<button
										class="pf-seg-o"
										class:on={cs.safeSearch === v}
										onclick={() => {
											settings.set("safeSearch", v);
										}}>{l}</button
									>
								{/each}
							</div>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">Result language</div>
						<div class="pf-ctrl">
							<select
								class="pf-select"
								value={cs.language}
								onchange={(e) => {
									settings.set("language", e.currentTarget.value);
								}}
							>
								{#each [["auto", "Auto-detect"], ["en", "English"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"], ["pt", "Português"], ["ja", "日本語"]] as [v, l] (v)}
									<option value={v}>{l}</option>
								{/each}
							</select>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">
							Autocomplete
							<div class="pf-hint">Search-as-you-type suggestions</div>
						</div>
						<div class="pf-ctrl">
							<button
								class="pf-toggle"
								class:on={cs.autocomplete}
								role="switch"
								aria-checked={cs.autocomplete}
								aria-label="Autocomplete"
								onclick={() => {
									settings.set("autocomplete", !cs.autocomplete);
								}}><span class="pf-thumb"></span></button
							>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">Open results in new tab</div>
						<div class="pf-ctrl">
							<button
								class="pf-toggle"
								class:on={cs.openNewTab}
								role="switch"
								aria-checked={cs.openNewTab}
								aria-label="Open results in new tab"
								onclick={() => {
									settings.set("openNewTab", !cs.openNewTab);
								}}><span class="pf-thumb"></span></button
							>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">
							Infinite scroll
							<div class="pf-hint">Auto-load more results as you scroll</div>
						</div>
						<div class="pf-ctrl">
							<button
								class="pf-toggle"
								class:on={cs.infiniteScroll}
								role="switch"
								aria-checked={cs.infiniteScroll}
								aria-label="Infinite scroll"
								onclick={() => {
									settings.set("infiniteScroll", !cs.infiniteScroll);
								}}><span class="pf-thumb"></span></button
							>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">
							Claire, the AI answer
							<div class="pf-hint">
								A cited answer above results. Every claim is verified against its source.
							</div>
						</div>
						<div class="pf-ctrl">
							<button
								class="pf-toggle"
								class:on={cs.aiAnswer}
								role="switch"
								aria-checked={cs.aiAnswer}
								aria-label="Claire, the AI answer"
								onclick={() => {
									settings.set("aiAnswer", !cs.aiAnswer);
								}}><span class="pf-thumb"></span></button
							>
						</div>
					</div>
				</div>
			{:else if section === "appearance"}
				<div class="pf-card">
					<div class="pf-card-h mono">Appearance</div>
					<div class="pf-row">
						<div class="pf-label">Theme</div>
						<div class="pf-ctrl">
							<div class="pf-seg">
								{#each [["light", "Light"], ["dark", "Dark"], ["auto", "Auto"]] as [v, l] (v)}
									<button
										class="pf-seg-o"
										class:on={theme.pref === v}
										onclick={() => {
											theme.apply(v as ThemePref);
										}}>{l}</button
									>
								{/each}
							</div>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">
							Accent
							<div class="pf-hint">Buttons & active states</div>
						</div>
						<div class="pf-ctrl">
							<div class="pf-swatches">
								{#each ACCENTS as c (c)}
									<button
										class="pf-swatch"
										class:on={(cs.accent || "") === c}
										class:pf-swatch-default={!c}
										style:background={c || undefined}
										title={c || "Default"}
										aria-label={c || "Default accent"}
										onclick={() => {
											settings.set("accent", c);
										}}
									></button>
								{/each}
							</div>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">Density</div>
						<div class="pf-ctrl">
							<div class="pf-seg">
								{#each [["spacious", "Spacious"], ["compact", "Compact"]] as [v, l] (v)}
									<button
										class="pf-seg-o"
										class:on={cs.density === v}
										onclick={() => {
											settings.set("density", v);
										}}>{l}</button
									>
								{/each}
							</div>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">Corners</div>
						<div class="pf-ctrl">
							<div class="pf-seg">
								{#each [["rounded", "Rounded"], ["sharp", "Sharp"]] as [v, l] (v)}
									<button
										class="pf-seg-o"
										class:on={cs.radius === v}
										onclick={() => {
											settings.set("radius", v);
										}}>{l}</button
									>
								{/each}
							</div>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">Font</div>
						<div class="pf-ctrl">
							<div class="pf-seg">
								{#each [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"]] as [v, l] (v)}
									<button
										class="pf-seg-o"
										class:on={cs.font === v}
										onclick={() => {
											settings.set("font", v);
										}}>{l}</button
									>
								{/each}
							</div>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">
							Engine badges
							<div class="pf-hint">Show which engines returned each result</div>
						</div>
						<div class="pf-ctrl">
							<button
								class="pf-toggle"
								class:on={cs.engineBadges}
								role="switch"
								aria-checked={cs.engineBadges}
								aria-label="Engine badges"
								onclick={() => {
									settings.set("engineBadges", !cs.engineBadges);
								}}><span class="pf-thumb"></span></button
							>
						</div>
					</div>
				</div>
			{:else if section === "privacy"}
				<div class="pf-card">
					<div class="pf-card-h mono">Privacy</div>
					<div class="pf-row">
						<div class="pf-label">
							Save searches on this device
							<div class="pf-hint">Recent-search history (local only)</div>
						</div>
						<div class="pf-ctrl">
							<button
								class="pf-toggle"
								class:on={cs.saveQueries}
								role="switch"
								aria-checked={cs.saveQueries}
								aria-label="Save searches"
								onclick={() => {
									settings.set("saveQueries", !cs.saveQueries);
								}}><span class="pf-thumb"></span></button
							>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">
							Proxy images
							<div class="pf-hint">Load images through the instance, not the source</div>
						</div>
						<div class="pf-ctrl">
							<button
								class="pf-toggle"
								class:on={cs.imageProxy}
								role="switch"
								aria-checked={cs.imageProxy}
								aria-label="Proxy images"
								onclick={() => {
									settings.set("imageProxy", !cs.imageProxy);
								}}><span class="pf-thumb"></span></button
							>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">Request method</div>
						<div class="pf-ctrl">
							<div class="pf-seg">
								{#each [["GET", "GET"], ["POST", "POST"]] as [v, l] (v)}
									<button
										class="pf-seg-o"
										class:on={cs.method === v}
										onclick={() => {
											settings.set("method", v);
										}}>{l}</button
									>
								{/each}
							</div>
						</div>
					</div>
					<div class="pf-row">
						<div class="pf-label">Cookies</div>
						<div class="pf-ctrl">
							<div class="pf-seg">
								{#each [["session", "Session"], ["persist", "Remember"], ["none", "Block"]] as [v, l] (v)}
									<button
										class="pf-seg-o"
										class:on={cs.cookies === v}
										onclick={() => {
											settings.set("cookies", v);
										}}>{l}</button
									>
								{/each}
							</div>
						</div>
					</div>
				</div>
				<div class="pf-note">
					Nothing about you leaves this instance — searches are proxied and never logged.
				</div>
			{:else if section === "engines"}
				{#if !engines.length}
					<div class="pf-card">
						<div class="pf-card-h mono">Engines</div>
						<div class="pf-empty">Loading engines…</div>
					</div>
				{:else}
					<div class="pf-card">
						<div class="pf-card-h mono">Engines · {engines.length}</div>
						<div class="pf-eng-bar">
							<button
								class="pf-mini"
								onclick={() => {
									settings.set("disabledEngines", []);
								}}>Enable all</button
							>
							<button
								class="pf-mini"
								onclick={() => {
									settings.set(
										"disabledEngines",
										engines.map((x) => x.name),
									);
								}}>Disable all</button
							>
						</div>
						{#each engines as e (e.name)}
							<div class="pf-eng-row">
								<span class="pf-eng-name">{e.name}</span>
								<span class="pf-eng-cats mono">{(e.cats || []).slice(0, 3).join(", ")}</span>
								<button
									class="pf-toggle"
									class:on={engineOn(e.name)}
									role="switch"
									aria-checked={engineOn(e.name)}
									aria-label={e.name}
									onclick={() => {
										toggleEngine(e.name);
									}}><span class="pf-thumb"></span></button
								>
							</div>
						{/each}
					</div>
				{/if}
			{:else if section === "hotkeys"}
				<div class="pf-card">
					<div class="pf-card-h mono">Keyboard shortcuts</div>
					{#each HOTKEYS as [k, d] (k)}
						<div class="pf-row">
							<div class="pf-label">{d}</div>
							<div class="pf-ctrl"><kbd class="kbd">{k}</kbd></div>
						</div>
					{/each}
				</div>
			{:else if section === "about"}
				<div class="pf-card">
					<div class="pf-card-h mono">About this instance</div>
					<div class="pf-row">
						<div class="pf-label">Instance</div>
						<div class="pf-ctrl"><code class="pf-code">clarity.petalcat.dev</code></div>
					</div>
					<div class="pf-row">
						<div class="pf-label">Backend</div>
						<div class="pf-ctrl"><code class="pf-code">SearXNG</code></div>
					</div>
					<div class="pf-row">
						<div class="pf-label">Engines</div>
						<div class="pf-ctrl"><span class="mono">{engines.length || "—"}</span></div>
					</div>
					<div class="pf-row">
						<div class="pf-label">Build</div>
						<div class="pf-ctrl"><span class="mono">v20</span></div>
					</div>
				</div>
				<div class="pf-about-links">
					<a href="https://github.com/searxng/searxng" target="_blank" rel="noopener">Source</a>
					<a href="https://search.petalcat.dev">Classic UI</a>
					<a href="https://docs.searxng.org/donate.html" target="_blank" rel="noopener">Donate</a>
				</div>
			{/if}
		</div>
	</div>
	<footer class="pf-foot">
		<span class="dot"></span><span class="mono">Stored locally on this device</span>
	</footer>
</div>
