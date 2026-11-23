// Clarity theme — light / dark / auto, persisted to 'clarity-theme', applied as
// data-theme="light|dark" on <html>. Ported from app.ts's applyTheme/setTheme/
// getTheme (the old window.* bridge). The anti-FOUC inline script in app.html
// resolves + paints the theme before first paint; this runes store re-syncs on
// hydration and powers the toggle + the prefs segmented control.
//
// Progressive enhancement: JS off → the head script's resolved theme stands and
// the toggle simply can't change it.

import { browser } from "$app/env";

export type ThemePref = "light" | "dark" | "auto";

const KEY = "clarity-theme";
const sysDark = () => browser && window.matchMedia?.("(prefers-color-scheme: dark)").matches;

function resolve(pref: ThemePref): "light" | "dark" {
	return pref === "dark" || (pref === "auto" && sysDark()) ? "dark" : "light";
}

class ThemeState {
	/** The user's preference (light/dark/auto), what the segmented control shows. */
	pref = $state<ThemePref>("auto");
	/** The resolved concrete theme on <html> (light/dark), what the toggle reflects. */
	resolved = $state<"light" | "dark">("light");

	init() {
		if (!browser) {
			return;
		}

		let saved: string | null = null;

		try {
			saved = localStorage.getItem(KEY);
		} catch {
			/* blocked */
		}

		this.pref = (saved as ThemePref) || "auto";
		this.apply(this.pref, false);

		window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
			if (this.pref === "auto") {
				this.apply("auto", false);
			}
		});
	}

	apply(pref: ThemePref, persist = true) {
		if (!browser) {
			return;
		}

		this.pref = pref;
		const dark = resolve(pref);

		this.resolved = dark;
		document.documentElement.dataset.theme = dark;

		if (persist) {
			try {
				localStorage.setItem(KEY, pref);
			} catch {
				/* blocked */
			}
		}
	}

	/** Header sun/moon toggle: flip the concrete theme (mirrors legacy click handler). */
	toggle() {
		const next: ThemePref = this.resolved === "dark" ? "light" : "dark";

		this.apply(next);
	}
}

export const theme = new ThemeState();
