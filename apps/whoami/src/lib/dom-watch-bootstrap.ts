// The pre-paint half of $lib/dom-injection. hooks.server.ts inlines installDomWatch as a <script>
// at the top of <head>, so it starts watching before <body> is parsed or painted. It only buffers
// records until watchDomInjection takes over; it classifies nothing and sends nothing.

export interface EarlyDomWatch {
	t0: number;
	q: [number, MutationRecord[]][];
	o: MutationObserver;
	cb: ((records: MutationRecord[], t: number) => void) | null;
}

declare global {
	interface Window {
		whoamiDomWatch?: EarlyDomWatch;
	}
}

/**
 * Start the observer, once. It ships to the browser as its own source text, so it must stay
 * self-contained: no imports, no references to anything outside its body.
 */
export function installDomWatch(): EarlyDomWatch {
	const existing = window.whoamiDomWatch;

	if (existing) {
		return existing;
	}

	const q: EarlyDomWatch["q"] = [];
	const watch: EarlyDomWatch = {
		t0: performance.now(),
		q,
		cb: null,
		o: new MutationObserver((records) => {
			const t = performance.now();

			if (watch.cb) {
				watch.cb(records, t);
			} else {
				q.push([t, records]);
			}
		}),
	};

	watch.o.observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeOldValue: true,
	});

	window.whoamiDomWatch = watch;

	return watch;
}

export const DOM_WATCH_SCRIPT = `<script>(${installDomWatch.toString()})();</script>`;
