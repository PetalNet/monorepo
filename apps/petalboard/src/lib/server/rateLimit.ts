const FIFTEEN_MINUTES = 15 * 60 * 1000;

export const EMAIL_LIMIT = { limit: 3, windowMs: FIFTEEN_MINUTES };
export const IP_LIMIT = { limit: 20, windowMs: FIFTEEN_MINUTES };
// Caps what the app as a whole mails out, whoever asks and for whichever addresses.
export const SEND_LIMIT = { limit: 100, windowMs: 60 * 60 * 1000 };

interface Window {
	start: number;
	count: number;
	windowMs: number;
}

const windows = new Map<string, Window>();

function current(key: string, windowMs: number, now: number) {
	const window = windows.get(key);

	return window && now - window.start < windowMs ? window : null;
}

function sweep(now: number) {
	for (const [key, window] of windows) {
		if (now - window.start >= window.windowMs) {
			windows.delete(key);
		}
	}
}

export function take(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
	const window = current(key, windowMs, now);

	if (!window) {
		if (windows.size > 10_000) {
			sweep(now);
		}

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

// Production runs behind a Cloudflare tunnel and Traefik, so the socket address is the proxy's.
export function clientIp(request: Request, getClientAddress: () => string): string {
	return request.headers.get("cf-connecting-ip") ?? getClientAddress();
}
