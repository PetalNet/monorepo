/**
 * Printer and server messages in plain words with the recovery step. The daemon speaks in short
 * lowercase phrases ("cover open", "no tape"); match on those.
 */
const PLAIN: readonly [RegExp, string][] = [
	[/cover open/i, "Cover open. Close it and retry."],
	[/no tape/i, "No tape. Insert a cassette and retry."],
	[/wrong tape/i, "Wrong tape loaded. Swap the cassette or switch the design's tape width."],
	[/cutter jam/i, "Cutter jam. Clear the cutter and retry."],
	[/overheat/i, "Printer overheated. Let it cool for a minute and retry."],
	[
		/(printer|device|usb)[^.]*not found|not connected|unreachable|offline|connection refused/i,
		"Printer offline. Check it is on and connected.",
	],
	[/battery/i, "Battery low. Plug the printer in and retry."],
];

export function plainError(message: string): string {
	for (const [pattern, words] of PLAIN) {
		if (pattern.test(message)) {
			return words;
		}
	}

	return message;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
	["second", 60],
	["minute", 60],
	["hour", 24],
	["day", 7],
	["week", 4.35],
	["month", 12],
	["year", Infinity],
];

/** "3 minutes ago", "yesterday". */
export function relativeTime(iso: string, now = Date.now()): string {
	let value = (new Date(iso).getTime() - now) / 1000;

	for (const [unit, size] of STEPS) {
		if (Math.abs(value) < size) {
			return RELATIVE.format(Math.round(value), unit);
		}

		value /= size;
	}

	return iso;
}

/** One decimal under 100 mm, whole millimetres above. */
export function formatMm(mm: number): string {
	return mm < 100 ? mm.toFixed(1) : String(Math.round(mm));
}
