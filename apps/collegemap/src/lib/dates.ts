/**
 * Calendar-date arithmetic that cannot be moved by a timezone.
 *
 * Every date in this app is a _calendar day_, never an instant. "Winter break starts Dec 19" means
 * Dec 19 wherever you are standing. So dates live as `YYYY-MM-DD` strings in the database and as
 * integer _day numbers_ (days since 1970-01-01) in arithmetic. Both are timezone-free.
 *
 * The two rules that keep it that way:
 *
 * 1. Never call `new Date('2026-12-19')` and then read `getFullYear()` / `getMonth()` / `getDate()`.
 *    Date-only ISO strings parse as UTC midnight, and those getters are local, so anywhere west of
 *    Greenwich you get the previous day.
 * 2. Never format with `toLocaleDateString()` without `timeZone: 'UTC'`, for the same reason.
 */

const MS_PER_DAY = 86_400_000;
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** A UTC-midnight `Date` for a calendar day, safe for every 4-digit year. */
function utcMidnight(year: number, month1: number, day: number): Date {
	const d = new Date(0);
	// setUTCFullYear avoids the Date.UTC two-digit-year trap (Date.UTC(99,...)
	// means 1999). Irrelevant for 2026, but this is the cheap correct version.
	d.setUTCFullYear(year, month1 - 1, day);
	d.setUTCHours(0, 0, 0, 0);
	return d;
}

/**
 * True only for a real calendar date in `YYYY-MM-DD` form. Rejects 2026-02-30.
 *
 * Returns a plain boolean rather than a `value is string` predicate on purpose: validity here is a
 * runtime fact about the contents, and narrowing `unknown` to `string` tells a caller that already
 * holds a `string` nothing it did not know.
 */
export function isIsoDate(value: unknown): boolean {
	if (typeof value !== "string" || !ISO_SHAPE.test(value)) return false;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	if (month < 1 || month > 12 || day < 1 || day > 31) return false;
	const probe = utcMidnight(year, month, day);
	return (
		probe.getUTCFullYear() === year &&
		probe.getUTCMonth() === month - 1 &&
		probe.getUTCDate() === day
	);
}

/** `YYYY-MM-DD` to an integer day number (days since 1970-01-01). */
export function toDay(iso: string): number {
	const year = Number(iso.slice(0, 4));
	const month = Number(iso.slice(5, 7));
	const day = Number(iso.slice(8, 10));
	return Math.round(utcMidnight(year, month, day).getTime() / MS_PER_DAY);
}

/** Integer day number back to `YYYY-MM-DD`. Exact inverse of `toDay`. */
export function fromDay(dayNumber: number): string {
	const d = new Date(dayNumber * MS_PER_DAY);
	const year = String(d.getUTCFullYear()).padStart(4, "0");
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** Inclusive length of a day range: Dec 19 to Dec 19 is 1 day, not 0. */
export function dayCount(startDay: number, endDay: number): number {
	return endDay - startDay + 1;
}

export function addDays(iso: string, delta: number): string {
	return fromDay(toDay(iso) + delta);
}

/** Today as a calendar date in a named timezone. `en-CA` formats as YYYY-MM-DD. */
export function todayIso(timeZone?: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
}

const FORMAT_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = JSON.stringify(options);
	let f = FORMAT_CACHE.get(key);
	if (!f) {
		// timeZone: 'UTC' is the whole point: our day numbers are UTC midnights,
		// so formatting in UTC renders the calendar day we actually mean.
		f = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
		FORMAT_CACHE.set(key, f);
	}
	return f;
}

/** "Sat Dec 19" — no year. */
export function formatShort(iso: string): string {
	return formatter({ weekday: "short", month: "short", day: "numeric" }).format(
		new Date(toDay(iso) * MS_PER_DAY),
	);
}

/** "Dec 19, 2026" */
function formatWithYear(iso: string): string {
	return formatter({ month: "short", day: "numeric", year: "numeric" }).format(
		new Date(toDay(iso) * MS_PER_DAY),
	);
}

/** "Dec 19" — no weekday, no year. */
function formatBare(iso: string): string {
	return formatter({ month: "short", day: "numeric" }).format(new Date(toDay(iso) * MS_PER_DAY));
}

function yearOf(iso: string): number {
	return Number(iso.slice(0, 4));
}

/**
 * A range as one line.
 *
 * Four cases, and they all matter: same day -> "Wed, Nov 25" (never "Nov 25 to Nov 25") crosses a
 * New Year -> "Dec 19, 2026 to Jan 10, 2027" (both years, always: this is the range people misread)
 * inside this year -> "Thu, Nov 26 to Sun, Nov 29" (weekdays are what you plan by) inside another
 * year -> "Jan 5 to Jan 10, 2027" (the year is what matters, so drop the weekdays rather than
 * mixing the two styles)
 */
export function formatRange(startIso: string, endIso: string, referenceYear: number): string {
	const startYear = yearOf(startIso);
	const endYear = yearOf(endIso);
	if (startIso === endIso) {
		return startYear === referenceYear ? formatShort(startIso) : formatWithYear(startIso);
	}
	if (startYear !== endYear) {
		return `${formatWithYear(startIso)} to ${formatWithYear(endIso)}`;
	}
	if (startYear === referenceYear) {
		return `${formatShort(startIso)} to ${formatShort(endIso)}`;
	}
	return `${formatBare(startIso)} to ${formatWithYear(endIso)}`;
}

/** First day of the month containing `iso`. */
export function startOfMonth(iso: string): string {
	return `${iso.slice(0, 7)}-01`;
}

/** First day of the month after the one containing `iso`. */
export function startOfNextMonth(iso: string): string {
	const year = yearOf(iso);
	const month = Number(iso.slice(5, 7));
	return month === 12
		? `${String(year + 1)}-01-01`
		: `${String(year)}-${String(month + 1).padStart(2, "0")}-01`;
}
