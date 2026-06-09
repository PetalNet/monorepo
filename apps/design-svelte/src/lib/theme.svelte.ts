// Theme state + the instant, flash-free, jump-free apply() — ported from the
// source page's <script>. The anti-FOUC head script (in app.html) sets
// data-theme before paint; this module re-applies on hydration and powers the
// toggle. It's a progressive enhancement: with JS off, the page renders the
// SSR light theme (or the head script's resolved theme) and simply can't toggle.

import { browser } from "$app/environment";

export type Theme = "light" | "dark";

const rmQuery =
	browser && window.matchMedia
		? window.matchMedia("(prefers-reduced-motion: reduce)")
		: { matches: false };
export const reducedMotion = () => rmQuery.matches;

class ThemeState {
	current = $state<Theme>("light");

	init() {
		if (!browser) return;
		let saved: string | null = null;
		try {
			saved = localStorage.getItem("petalnet-theme");
		} catch {
			// localStorage may be unavailable (private mode / blocked); ignore.
		}
		const initial: Theme =
			(saved as Theme) ||
			(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
				? "dark"
				: "light");
		// Mirror the resolved theme into state without re-running the no-transition
		// dance (the head script already painted it; this just syncs the buttons).
		this.current = initial;
		document.documentElement.setAttribute("data-theme", initial);
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.setAttribute("content", initial === "dark" ? "#0d0c0b" : "#ffffff");
	}

	#noTransRaf: number | null = null;

	apply(theme: Theme, persist = true) {
		if (!browser) return;
		const root = document.documentElement;
		if (this.#noTransRaf) cancelAnimationFrame(this.#noTransRaf);
		root.classList.add("no-theme-transition");
		root.setAttribute("data-theme", theme);
		this.current = theme;
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.setAttribute("content", theme === "dark" ? "#0d0c0b" : "#ffffff");
		if (persist) {
			try {
				localStorage.setItem("petalnet-theme", theme);
			} catch {
				// localStorage may be unavailable (private mode / blocked); ignore.
			}
		}
		void root.offsetWidth; // flush the swap with transitions disabled
		this.#noTransRaf = requestAnimationFrame(() => {
			root.classList.remove("no-theme-transition");
			this.#noTransRaf = null;
		});
	}

	toggle() {
		this.apply(this.current === "dark" ? "light" : "dark");
	}
}

export const theme = new ThemeState();
