import type { Store } from "../store";
import { SERVICES, type Service } from "./services";

const AGENT = "chaos-tracker (status check)";
const TIMEOUT = 10_000;
/** A heavy feed is read again only after this long: in practice once an hour. */
const SLOW_EVERY = 55 * 60 * 1000;

/** AWS serves its event list as UTF-16 behind a byte-order mark; everything else is UTF-8. */
function decode(bytes: ArrayBuffer): string {
	const mark = bytes.byteLength >= 2 ? new DataView(bytes).getUint16(0) : 0;
	const encoding = mark === 0xfe_ff ? "utf-16be" : mark === 0xff_fe ? "utf-16le" : "utf8";

	return new TextDecoder(encoding).decode(bytes);
}

async function readClaim(
	service: Service,
	store: Store,
	fetcher: typeof fetch,
	now: Date,
): Promise<void> {
	const last = store.claim(service.id)?.checkedAt;

	if (service.slow && last && now.getTime() - Date.parse(last) < SLOW_EVERY) {
		return;
	}

	const response = await fetcher(service.feed, {
		headers: { "User-Agent": AGENT },
		signal: AbortSignal.timeout(TIMEOUT),
	});

	if (!response.ok) {
		await response.body?.cancel();

		throw new Error(`${service.id} status feed answered ${String(response.status)}`);
	}

	store.saveClaim(service.id, service.parse(decode(await response.arrayBuffer())), now);
}

/**
 * One request to the service itself. Any HTTP answer below 500 means the service is reachable from
 * here: a 401 from an API that wants a key is still the API answering.
 */
async function probe(
	service: Service,
	store: Store,
	fetcher: typeof fetch,
	now: Date,
): Promise<void> {
	const started = performance.now();
	let detail: string;
	let reachable = false;

	try {
		const response = await fetcher(service.probe, {
			headers: { "User-Agent": AGENT },
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT),
		});

		await response.body?.cancel();
		reachable = response.status < 500;

		detail = reachable
			? `${String(Math.round(performance.now() - started))} ms`
			: `HTTP ${String(response.status)}`;
	} catch (error) {
		detail =
			error instanceof Error && error.name === "TimeoutError" ? "Timed out" : "No connection";
	}

	store.saveProbe(service.id, reachable, detail, now);
}

/**
 * One round: read every status page and probe every service. A feed that fails keeps its last
 * stored claim, which the board stops showing once it is old.
 */
export async function watch(
	store: Store,
	fetcher: typeof fetch = fetch,
	now = new Date(),
): Promise<string[]> {
	const failures: string[] = [];

	await Promise.all(
		SERVICES.flatMap((service) => [
			readClaim(service, store, fetcher, now).catch((error: unknown) => {
				failures.push(error instanceof Error ? error.message : String(error));
			}),
			probe(service, store, fetcher, now),
		]),
	);

	return failures;
}
