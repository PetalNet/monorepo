import { mode, setMode, setTheme } from "mode-watcher";
import { tick } from "svelte";

export class Theme {
	readonly dark = $derived(mode.current === "dark");

	toggle() {
		if (
			window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
			!document.startViewTransition
		) {
			this.#applyToggle();
			return;
		}

		document.startViewTransition(async () => {
			this.#applyToggle();
			await tick();
		});
	}

	#applyToggle() {
		const nextMode = this.dark ? "light" : "dark";
		setMode(nextMode);
		// DaisyUI reads data-theme; mode remains Grove's source of truth.
		setTheme(nextMode);
	}
}
