import { browser } from "$app/environment";

/**
 * A shared 1s wall clock. Time-derived UI (lease countdowns, gone-quiet staleness, age labels) must
 * recompute as time passes, not freeze at render — a frozen clock renders stale operational state
 * as current (§4.6 honesty). Read `clockNow()` inside a component and it ticks reactively.
 */
let current = $state(Date.now());

if (browser) {
	setInterval(() => {
		current = Date.now();
	}, 1000);
}

export function clockNow(): number {
	return current;
}
