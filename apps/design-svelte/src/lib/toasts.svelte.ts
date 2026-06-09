// Snackbar notice store — ported from the source page's fireToast(). The visible
// stack is capped to ~5 by the host's max-height + scroll; the DOM is capped at
// MAX_TOASTS so unbounded firing can't grow memory. Enhancement-only (needs JS).

import { reducedMotion } from "./theme.svelte";

const MAX_TOASTS = 12;

export interface Toast {
	id: number;
	msg: string;
	show: boolean;
}

class ToastStore {
	items = $state<Toast[]>([]);
	#seq = 0;

	fire(msg: string) {
		// drop the oldest beyond the DOM cap (oldest = first in array)
		while (this.items.length >= MAX_TOASTS) this.items.shift();
		const id = ++this.#seq;
		this.items.push({ id, msg, show: false });
		// next frame: flip .show so the enter transition runs (matches source's
		// reflow-then-add-class). $state mutation already schedules a re-render.
		requestAnimationFrame(() => {
			const t = this.items.find((x) => x.id === id);
			if (t) t.show = true;
		});
		const auto = setTimeout(() => this.remove(id), 4200);
		// store the timer so an early dismiss can clear it
		this.#timers.set(id, auto);
	}

	#timers = new Map<number, ReturnType<typeof setTimeout>>();

	remove(id: number) {
		const t = this.items.find((x) => x.id === id);
		if (!t || !t.show) {
			// already removed or removing
			if (!this.items.some((x) => x.id === id)) return;
		}
		const auto = this.#timers.get(id);
		if (auto) {
			clearTimeout(auto);
			this.#timers.delete(id);
		}
		if (t) t.show = false;
		if (reducedMotion()) {
			this.items = this.items.filter((x) => x.id !== id);
		} else {
			setTimeout(() => {
				this.items = this.items.filter((x) => x.id !== id);
			}, 280);
		}
	}
}

export const toasts = new ToastStore();
