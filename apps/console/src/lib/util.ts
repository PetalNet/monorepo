/** Small shared UI helpers. */

/** First letter of a name, for avatar/initial chips. */
export function initial(handle: string): string {
	return handle[0].toUpperCase();
}

/** Deterministic avatar hue for an agent handle (foundations §3.7 "hue by handle"). */
export function hueForHandle(handle: string): number {
	let h = 0;
	for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) % 360;
	return h;
}

/** Compact token count: 612000 -> "612k", 1_420_000 -> "1.42M". */
export function compactTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1000) return `${String(Math.round(n / 1000))}k`;
	return String(n);
}
