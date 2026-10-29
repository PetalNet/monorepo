/** Dial geometry. Angles are degrees clockwise from twelve o'clock; the dial centre is the origin. */

export const polar = (degrees: number, radius: number) => {
	const radians = (degrees * Math.PI) / 180;

	return { x: radius * Math.sin(radians), y: -radius * Math.cos(radians) };
};

const fixed = (value: number) => value.toFixed(2);

/** A clockwise arc of `sweep` degrees starting at `from`. A full turn is drawn as two halves. */
export const arcPath = (from: number, sweep: number, radius: number): string => {
	const clamped = Math.max(0, Math.min(360, sweep));
	if (clamped === 0) return "";
	if (clamped >= 359.99) return `${arcPath(from, 180, radius)} ${arcPath(from + 180, 180, radius)}`;

	const start = polar(from, radius);
	const end = polar(from + clamped, radius);

	return `M ${fixed(start.x)} ${fixed(start.y)} A ${String(radius)} ${String(radius)} 0 ${clamped > 180 ? "1" : "0"} 1 ${fixed(end.x)} ${fixed(end.y)}`;
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
