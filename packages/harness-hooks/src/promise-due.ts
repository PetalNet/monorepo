// When is a promise due? Parsed from the promise's own words when it states a time ("tomorrow", "tonight", "after the
// reset", "Friday 9", "in 20 minutes"); otherwise undefined and the caller applies its default grace. Every stated
// time gets slack after it, because the due time is when to ask "did this happen?", not when the work starts.
// All wall-clock arithmetic happens in the configured time zone.

export interface DueOptions {
	/** IANA zone the agent's people live in, for example "America/Chicago". */
	timeZone: string;
	/** Local hour at which the agent's usage allowance resets ("after the reset"). */
	resetHour: number;
}

export interface Due {
	/** Epoch milliseconds. */
	at: number;
	/** The words the time was read from. */
	stated: string;
}

interface Wall {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	/** 0 is Sunday. */
	weekday: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The wall-clock reading of an instant in a zone. */
export function wall(at: number, timeZone: string): Wall {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		weekday: "long",
	}).formatToParts(at);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

	return {
		year: Number(get("year")),
		month: Number(get("month")),
		day: Number(get("day")),
		hour: Number(get("hour")),
		minute: Number(get("minute")),
		weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase()),
	};
}

/**
 * The instant at which a zone's wall clock reads the given time. Day overflow (day 32, hour 25)
 * carries.
 */
export function instant(
	timeZone: string,
	year: number,
	month: number,
	day: number,
	hour = 0,
	minute = 0,
): number {
	const target = Date.UTC(year, month - 1, day, hour, minute);
	let guess = target;

	// Two passes settle the zone offset, including across a daylight-saving change.
	for (let pass = 0; pass < 2; pass += 1) {
		const w = wall(guess, timeZone);

		guess += target - Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
	}

	return guess;
}

function clock(
	hourText: string,
	minuteText: string | undefined,
	meridiem: string | undefined,
): [number, number] {
	let hour = Number(hourText);
	const minute = minuteText === undefined ? 0 : Number(minuteText);
	const mer = meridiem?.toLowerCase().replaceAll(".", "");

	if (mer === "pm" && hour < 12) {
		hour += 12;
	} else if (mer === "am" && hour === 12) {
		hour = 0;
	} else if (mer === undefined && hour >= 1 && hour <= 6) {
		// "at 4:45" in chat means the afternoon.
		hour += 12;
	}

	return [hour, minute];
}

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?`;

/** The due time a sentence states, or undefined when it states none that is still ahead. */
export function parseDue(sentence: string, now: number, options: DueOptions): Due | undefined {
	const { timeZone, resetHour } = options;
	const text = sentence.toLowerCase();
	const w = wall(now, timeZone);
	const on = (dayOffset: number, hour: number, minute = 0) =>
		instant(timeZone, w.year, w.month, w.day + dayOffset, hour, minute);
	const found = (at: number, stated: string): Due | undefined =>
		at > now ? { at, stated } : undefined;
	let m: RegExpExecArray | null;

	// "in 20 minutes", "in a few minutes", "in an hour", "within the hour": the span, half again, at least 30 minutes.
	m =
		/\b(?:in|within) (?:the |about |around |roughly )?(a few|a couple of|an?|\d+)?\s*(min(?:ute)?s?|hours?|hrs?|days?)\b/u.exec(
			text,
		);

	if (m) {
		const count =
			m[1] === undefined || /^an?$/u.test(m[1]) ? 1 : m[1].startsWith("a ") ? 3 : Number(m[1]);
		const unit = m[2]?.startsWith("min") ? 60_000 : m[2]?.startsWith("d") ? DAY : HOUR;

		return found(now + Math.max(count * unit * 1.5, HOUR / 2), m[0]);
	}

	// "after the reset", "once my usage resets", "after 4am" when 4 is the reset hour: the next reset plus four hours.
	if (
		/\b(?:after|once|when|until|post)\b[^.!?]{0,30}\breset(?:s|ting)?\b/u.test(text) ||
		/\breset\b[^.!?]{0,20}\b(?:then|and then)\b/u.test(text)
	) {
		const today = on(0, resetHour);

		return found((today > now ? today : on(1, resetHour)) + 4 * HOUR, "after the reset");
	}

	// "Dec 10", "November 25 at 7:45pm": that day at the stated time plus an hour, else 20:00.
	m = new RegExp(
		String.raw`\b(${MONTHS.join("|")})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b(?:,? (?:at |by |around )?${TIME}(?=\W|$))?`,
		"u",
	).exec(text);

	if (m) {
		const month = MONTHS.indexOf(m[1] ?? "") + 1;
		const day = Number(m[2]);
		const [hour, minute] = m[3] === undefined ? [20, 0] : clock(m[3], m[4], m[5]);
		const year = month < w.month || (month === w.month && day < w.day) ? w.year + 1 : w.year;

		return found(
			instant(timeZone, year, month, day, hour, minute) + (m[3] === undefined ? 0 : HOUR),
			m[0],
		);
	}

	// "tomorrow", "tomorrow morning", "tomorrow at 9".
	m = new RegExp(
		String.raw`\btomorrow\b(?: (morning|afternoon|evening|night))?(?: (?:at|by|around) ${TIME}(?=\W|$))?`,
		"u",
	).exec(text);

	if (m) {
		if (m[2] !== undefined) {
			const [hour, minute] = clock(m[2], m[3], m[4]);

			return found(on(1, hour, minute) + HOUR, m[0]);
		}

		const hour = m[1] === "morning" ? 12 : m[1] === "afternoon" ? 18 : m[1] === undefined ? 20 : 23;

		return found(on(1, hour), m[0]);
	}

	// "Friday", "by Friday 9", "on Monday at 3pm": the next such day, never today.
	m = new RegExp(
		String.raw`\b(${WEEKDAYS.join("|")})\b(?: (morning|afternoon|evening|night))?(?:,? (?:at |by |around )?${TIME}(?=\W|$))?`,
		"u",
	).exec(text);

	if (m) {
		const ahead = (WEEKDAYS.indexOf(m[1] ?? "") - w.weekday + 7) % 7 || 7;

		if (m[3] !== undefined) {
			// "Friday 9" means nine in the morning.
			const [hour, minute] =
				m[5] === undefined ? [Number(m[3]), Number(m[4] ?? 0)] : clock(m[3], m[4], m[5]);

			return found(on(ahead, hour, minute) + HOUR, m[0]);
		}

		const hour = m[2] === "morning" ? 12 : m[2] === "afternoon" ? 18 : m[2] === undefined ? 20 : 23;

		return found(on(ahead, hour), m[0]);
	}

	if (/\b(?:tonight|this evening|later today|end of (?:the )?day|eod)\b/u.test(text)) {
		return found(on(0, 23, 30), "tonight");
	}

	if (/\bthis afternoon\b/u.test(text)) {
		return found(on(0, 18), "this afternoon");
	}

	if (/\b(?:overnight|in the morning|this morning|by morning|first thing)\b/u.test(text)) {
		const today = on(0, 12);

		return found(today > now && w.hour >= resetHour ? today : on(1, 12), "in the morning");
	}

	if (/\bnext week\b/u.test(text)) {
		return found(now + 7 * DAY, "next week");
	}

	// "at 4:45", "by 5pm", "around 9:30": today, plus an hour.
	m = new RegExp(String.raw`\b(?:at|by|around|before|until) (?:about )?${TIME}(?=\W|$)`, "u").exec(
		text,
	);

	if (m && (m[2] !== undefined || m[3] !== undefined)) {
		const [hour, minute] = clock(m[1] ?? "", m[2], m[3]);

		return found(on(0, hour, minute) + HOUR, m[0]);
	}

	return undefined;
}
