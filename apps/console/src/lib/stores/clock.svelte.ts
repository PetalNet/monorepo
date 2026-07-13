import { browser } from "$app/environment";

/**
 * A shared 1s wall clock. Time-derived UI (lease countdowns, gone-quiet staleness, age labels) must
 * recompute as time passes, not freeze at render — a frozen clock renders stale operational state
 * as current (§4.6 honesty). Read `clockNow()` inside a component and it ticks reactively.
 */
let current = $state(0);

if (browser) {
	current = Date.now();
	const interval = setInterval(() => {
		current = Date.now();
	}, 1000);
	import.meta.hot?.dispose(() => clearInterval(interval));
}

export function clockNow(): number {
	// A module can live for the whole server process. Never reuse its import-time timestamp for SSR.
	return browser ? current : Date.now();
}
