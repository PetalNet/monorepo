/** Dial geometry. Angles are degrees clockwise from twelve o'clock; the dial centre is the origin. */

export const polar = (degrees: number, radius: number) => {
	const radians = (degrees * Math.PI) / 180;

	return { x: radius * Math.sin(radians), y: -radius * Math.cos(radians) };
};

const fixed = (value: number) => value.toFixed(2);

/** A clockwise arc of `sweep` degrees starting at `from`. A full turn is drawn as two halves. */
export const arcPath = (from: number, sweep: number, radius: number): string => {
	const clamped = Math.max(0, Math.min(360, sweep));

	if (clamped === 0) {
		return "";
	}

	if (clamped >= 359.99) {
		return `${arcPath(from, 180, radius)} ${arcPath(from + 180, 180, radius)}`;
	}

	const start = polar(from, radius);
	const end = polar(from + clamped, radius);

	return `M ${fixed(start.x)} ${fixed(start.y)} A ${String(radius)} ${String(radius)} 0 ${clamped > 180 ? "1" : "0"} 1 ${fixed(end.x)} ${fixed(end.y)}`;
};

/**
 * An arc that text on a `textPath` reads left to right along, centred on `centre` and `span`
 * degrees long. On the upper half it runs clockwise with letter tops outward, on the lower half it
 * runs anticlockwise with letter tops inward, so lettering follows the rim instead of a chord.
 */
export const readingArc = (centre: number, span: number, radius: number): string => {
	const normal = ((centre % 360) + 360) % 360;
	const lower = normal > 90 && normal < 270;
	const start = polar(centre + (lower ? span / 2 : -span / 2), radius);
	const end = polar(centre + (lower ? -span / 2 : span / 2), radius);

	return `M ${fixed(start.x)} ${fixed(start.y)} A ${String(radius)} ${String(radius)} 0 ${span > 180 ? "1" : "0"} ${lower ? "0" : "1"} ${fixed(end.x)} ${fixed(end.y)}`;
};

/** EB Garamond's cap and figure height, in ems. */
export const CAP_HEIGHT = 0.65;

/** EB Garamond's ascender height (b, d, h, l), in ems. */
export const ASCENDER_HEIGHT = 0.71;

/**
 * The week dial's two 7-day rings, Claude outside and Codex inside. The gap between them holds the
 * inner ring's reset mark, so it is wider than a band.
 */
export const WEEK_RINGS = { radii: [79, 50], width: 15 } as const;

/** Radius of the centre boss that carries the date or time. */
export const BOSS_RADIUS = 31;

/** A line of text measured from its baseline to the top of its ink, `rise` ems above it. */
export interface InkLine {
	size: number;
	rise: number;
}

/**
 * Alphabetic baselines that centre a line, or a line and a caption under it, on the dial centre.
 * The block spans the first line's ink top to the last line's baseline; descenders hang inside the
 * stack or below it, as optical centring expects.
 */
export const stackBaselines = (
	line: InkLine,
	caption: InkLine | null,
	gap: number,
): { line: number; caption: number } => {
	const lineHeight = line.size * line.rise;
	const height = caption === null ? lineHeight : lineHeight + gap + caption.size * caption.rise;
	const lineBaseline = lineHeight - height / 2;

	return { line: lineBaseline, caption: height / 2 };
};

/** Smallest angle between two directions, in [0, 180]. */
const separation = (a: number, b: number): number =>
	Math.abs(((((a - b) % 360) + 540) % 360) - 180);

/**
 * Where a ring's usage figure goes: centred just past the end of the fill, on the bare groove, or
 * just inside the fill's end when that spot would sit on the hand or the reset diamond, or stepped
 * back inside a fill that runs up to the reset. `halfDeg` is half the figure's length along the
 * ring, as degrees. Null when neither spot is clear.
 */
export const usageLabelAt = (input: {
	start: number;
	fill: number;
	reset: number;
	hand: number;
	halfDeg: number;
	radius: number;
}): { angle: number; inside: boolean } | null => {
	const { start, fill, reset, hand, halfDeg, radius } = input;
	const degreesFor = (units: number) => (units / radius) * (180 / Math.PI);
	// The hand is under 4 units wide at the rings; the reset diamond is about 5.
	const clear = (angle: number) =>
		separation(angle, hand) > halfDeg + degreesFor(3) &&
		separation(angle, start + reset) > halfDeg + degreesFor(4);
	// A fill that runs up to the reset gets its figure stepped back inside it, clear of the diamond.
	const beforeReset = reset - halfDeg - degreesFor(4) - 0.5;
	const candidates = [
		{ angle: start + fill + halfDeg, inside: false, fits: fill + 2 * halfDeg <= reset },
		{ angle: start + fill - halfDeg, inside: true, fits: fill >= 2 * halfDeg },
		{
			angle: start + beforeReset,
			inside: true,
			fits: beforeReset + halfDeg <= fill && beforeReset >= halfDeg,
		},
	];

	const spot = candidates.find((candidate) => candidate.fits && clear(candidate.angle));

	return spot === undefined ? null : { angle: spot.angle, inside: spot.inside };
};

/** Degrees from `from` clockwise to `to`, in [0, 360). */
export const clockwise = (from: number, to: number): number => (((to - from) % 360) + 360) % 360;

const localMinuteOfDay = (epoch: number) => {
	const date = new Date(epoch);

	return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
};

/** Day dial: noon at the top and midnight at the bottom, as on the Prague Orloj's chapter ring. */
export const dayAngle = (epoch: number): number =>
	((localMinuteOfDay(epoch) / 1440) * 360 + 180) % 360;

/** Week dial: Monday 00:00 at the top, one seventh of the turn per day. */
export const weekAngle = (epoch: number): number => {
	const weekday = (new Date(epoch).getDay() + 6) % 7;

	return ((weekday * 1440 + localMinuteOfDay(epoch)) / (7 * 1440)) * 360;
};

const ROMAN = ["XII", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];

export const romanHour = (hour: number): string => ROMAN[hour % 12] ?? "";

/**
 * Rotation that lays text along the ring, reading left to right on both halves: tops of letters
 * point outward on the upper half and inward on the lower half.
 */
export const tangentRotation = (degrees: number): number => {
	const normal = ((degrees % 360) + 360) % 360;

	return normal > 90 && normal < 270 ? normal - 180 : normal;
};

/**
 * How a dial turns: the local clock angle of an instant, and how far the dial turns per local
 * minute.
 */
export interface DialScale {
	angle: (epoch: number) => number;
	degreesPerMinute: number;
}

export const DAY_SCALE: DialScale = { angle: dayAngle, degreesPerMinute: 360 / 1440 };
export const WEEK_SCALE: DialScale = { angle: weekAngle, degreesPerMinute: 360 / (7 * 1440) };

const utcOffsetMinutes = (epoch: number) => -new Date(epoch).getTimezoneOffset();

/**
 * Local wall-clock minutes between two instants. Across a DST change this differs from real minutes
 * by the hour the clocks moved, which is exactly how far a clock hand moves differently.
 */
const localMinutesBetween = (from: number, to: number): number =>
	(to - from) / 60_000 + utcOffsetMinutes(to) - utcOffsetMinutes(from);

export interface WindowGeometry {
	/** Angle of the window's start. Every sweep below runs clockwise from here. */
	start: number;
	/** Sweep to the reset. A 7-day window on the week dial is a full turn give or take a DST hour. */
	reset: number;
	/**
	 * Sweep of the groove. A window whose real length covers the whole dial gets the whole ring, so
	 * the DST hour between its start and reset angles never leaves a wedge of bare paper.
	 */
	groove: number;
	/** Sweep to the instant at which the usage share of the window would have passed. */
	fill: number;
	/** Sweep to where the burn rate lands, capped at the reset. */
	projection: number | null;
	/**
	 * The stretch the limit is spent for, as sweeps from the start, clamped inside the groove. When
	 * the clocks go back the reset can sit behind the start of the stretch on the dial, and it is
	 * empty.
	 */
	lockout: { from: number; sweep: number } | null;
}

/**
 * Places a window on a dial. Each point is the local clock angle of its own instant; fractions are
 * turned into instants in epoch time first, never multiplied by an arc of clock angles.
 */
export const windowGeometry = (
	window: {
		startsAt: number | null;
		resetsAt: number | null;
		usedPct: number | null;
		projectedPct: number | null;
		lockoutAt: number | null;
	},
	scale: DialScale,
): WindowGeometry | null => {
	const { startsAt, resetsAt } = window;

	if (startsAt === null || resetsAt === null) {
		return null;
	}

	const instantAt = (pct: number) =>
		startsAt + (Math.min(Math.max(pct, 0), 100) / 100) * (resetsAt - startsAt);
	const sweepTo = (epoch: number) =>
		localMinutesBetween(startsAt, Math.min(Math.max(epoch, startsAt), resetsAt)) *
		scale.degreesPerMinute;

	const lockout = () => {
		if (window.lockoutAt === null) {
			return null;
		}

		const reset = sweepTo(resetsAt);
		const from = Math.min(sweepTo(window.lockoutAt), reset);

		return { from, sweep: reset - from };
	};

	return {
		start: scale.angle(startsAt),
		reset: sweepTo(resetsAt),
		groove:
			((resetsAt - startsAt) / 60_000) * scale.degreesPerMinute >= 360 ? 360 : sweepTo(resetsAt),
		fill: window.usedPct === null ? 0 : sweepTo(instantAt(window.usedPct)),
		projection: window.projectedPct === null ? null : sweepTo(instantAt(window.projectedPct)),
		lockout: lockout(),
	};
};
