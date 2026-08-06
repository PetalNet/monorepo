import { mode, setMode } from "mode-watcher";
import { tick } from "svelte";

export class Theme {
	readonly dark = $derived(mode.current === "dark");

	toggle() {
		if (
			window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- startViewTransition is not available in all browsers (progressive enhancement)
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
	}
}
