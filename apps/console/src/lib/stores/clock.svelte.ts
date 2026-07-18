import { browser } from "$app/env";

type TemporalApi = typeof import("temporal-polyfill").Temporal;

const nativeTemporal = (): TemporalApi | undefined =>
	(globalThis as { Temporal?: TemporalApi }).Temporal;

async function loadTemporal(): Promise<TemporalApi> {
	return nativeTemporal() ?? (await import("temporal-polyfill")).Temporal;
}

let current = $state(Date.now());

if (browser) {
	let interval: ReturnType<typeof setInterval> | undefined;
	void loadTemporal().then((Temporal) => {
		const tick = () => {
			current = Temporal.Now.instant().epochMilliseconds;
		};
		tick();
		interval = setInterval(tick, 1000);
	});
	import.meta.hot?.dispose(() => {
		if (interval !== undefined) clearInterval(interval);
	});
}

export function clockNow(): number {
	if (browser) return current;
	const native = nativeTemporal();
	return native ? native.Now.instant().epochMilliseconds : Date.now();
}
