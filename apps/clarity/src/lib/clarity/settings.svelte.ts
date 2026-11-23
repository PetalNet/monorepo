// Clarity settings — the persisted 'clarity-settings' store, ported from the
// vanilla app's getCS()/applyVisual() + prefs.ts. Replaces the window.* bridge
// (getCS/applyVisual/setTheme/getTheme) with a single Svelte 5 runes store that
// both the search flow and the preferences UI read/write.
//
// Progressive enhancement: with JS off the page renders the SSR defaults; once
// hydrated this loads localStorage and applies the visual overrides (accent,
// radius, font, density, badges) onto <html> exactly as the legacy applyVisual.

import { browser } from "$app/env";

interface Settings {
	accent: string;
	density: string;
	radius: string;
	font: string;
	engineBadges: boolean;
	language: string;
	safeSearch: string;
	autocomplete: boolean;
	openNewTab: boolean;
	infiniteScroll: boolean;
	saveQueries: boolean;
	imageProxy: boolean;
	aiAnswer: boolean;
	method: string;
	cookies: string;
	disabledEngines: string[];
	[k: string]: unknown;
}

const SETTINGS_DEFAULTS: Settings = {
	accent: "",
	density: "spacious",
	radius: "rounded",
	font: "sans",
	engineBadges: true,
	language: "auto",
	safeSearch: "moderate",
	autocomplete: true,
	openNewTab: false,
	infiniteScroll: true,
	saveQueries: true,
	imageProxy: true,
	aiAnswer: true,
	method: "GET",
	cookies: "session",
	disabledEngines: [],
};

const KEY = "clarity-settings";

function read(): Settings {
	if (!browser) {
		return { ...SETTINGS_DEFAULTS };
	}

	try {
		const saved: unknown = JSON.parse(localStorage.getItem(KEY) || "{}");

		return { ...SETTINGS_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
	} catch {
		return { ...SETTINGS_DEFAULTS };
	}
}

class SettingsState {
	current = $state<Settings>({ ...SETTINGS_DEFAULTS });

	/** Hydrate from localStorage + apply the visual overrides. Call once on mount. */
	init() {
		if (!browser) {
			return;
		}

		this.current = read();
		this.applyVisual();
	}

	/** Persist + re-apply the live visual overrides. */
	persist() {
		if (!browser) {
			return;
		}

		try {
			localStorage.setItem(KEY, JSON.stringify(this.current));
		} catch {
			/* storage may be blocked */
		}

		this.applyVisual();
	}

	set<K extends keyof Settings>(k: K, v: Settings[K]) {
		this.current[k] = v;
		this.persist();
	}

	/** Mirror legacy applyVisual(): accent / radius / font / density / badges → <html>. */
	applyVisual() {
		if (!browser) {
			return;
		}

		const r = document.documentElement;
		const cs = this.current;

		if (cs.accent) {
			r.style.setProperty("--accent", cs.accent);
			r.style.setProperty("--accent-fg", "#ffffff");
		} else {
			r.style.removeProperty("--accent");
			r.style.removeProperty("--accent-fg");
		}

		r.style.setProperty("--radius", cs.radius === "sharp" ? "4px" : "14px");

		r.style.setProperty(
			"--font-sans",
			cs.font === "serif"
				? "'Newsreader', Georgia, serif"
				: cs.font === "mono"
					? "var(--font-mono)"
					: "'Geist', ui-sans-serif, system-ui, sans-serif",
		);

		r.classList.toggle("compact", cs.density === "compact");
		r.classList.toggle("no-badges", !cs.engineBadges);
	}
}

export const settings = new SettingsState();
