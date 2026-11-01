const FIFTEEN_MINUTES = 15 * 60 * 1000;

export const EMAIL_LIMIT = { limit: 3, windowMs: FIFTEEN_MINUTES };
export const IP_LIMIT = { limit: 20, windowMs: FIFTEEN_MINUTES };
export const SEND_LIMIT = { limit: 100, windowMs: 60 * 60 * 1000 };

interface Window {
	start: number;
	count: number;
	windowMs: number;
}

const SWEEP_EVERY = 60 * 1000;
const windows = new Map<string, Window>();
let lastSweep = 0;

function current(key: string, windowMs: number, now: number) {
	const window = windows.get(key);

	return window && now - window.start < windowMs ? window : null;
}

function sweep(now: number) {
	lastSweep = now;

	for (const [key, window] of windows) {
		if (now - window.start >= window.windowMs) {
			windows.delete(key);
		}
	}
}

export function take(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
	if (now - lastSweep >= SWEEP_EVERY) {
		sweep(now);
	}

	const window = current(key, windowMs, now);

	if (!window) {
		windows.set(key, { start: now, count: 1, windowMs });

		return true;
	}

	if (window.count >= limit) {
		return false;
	}

	window.count += 1;

	return true;
}

/** True when `key` has used up its window, without counting an attempt. */
export function isLimited(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
	return (current(key, windowMs, now)?.count ?? 0) >= limit;
}

/** @internal Lets tests see that expired windows are dropped. */
export function trackedKeys() {
	return windows.size;
}

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

// One IPv6 subscriber usually holds a whole /64, so a per-address key would give them billions.
function rateKey(ip: string) {
	const mapped = MAPPED_IPV4.exec(ip);

	if (mapped) {
		return mapped[1];
	}

	if (!ip.includes(":")) {
		return ip;
	}

	const [head, tail] = ip.split("%")[0].split("::");
	const before = head ? head.split(":") : [];
	const after = tail ? tail.split(":") : [];
	const zeros =
		tail === undefined ? [] : Array.from({ length: 8 - before.length - after.length }, () => "0");
	const prefix = [...before, ...zeros, ...after]
		.slice(0, 4)
		.map((group) => Number.parseInt(group, 16).toString(16));

	return `${prefix.join(":")}::/64`;
}

// The app port is published on 127.0.0.1 only, so every request arrives through Traefik from
// the Cloudflare tunnel and this header is Cloudflare's, not the client's.
export function clientIp(request: Request, getClientAddress: () => string): string {
	return rateKey(request.headers.get("cf-connecting-ip") ?? getClientAddress());
}
