const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * A countdown in its two most significant units, leading zero units dropped: 5d 15h, 3h 12m, 12m.
 * Partial minutes round down, so a countdown never shows more time than is left.
 */
export const formatDuration = (milliseconds: number): string => {
	const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
	const days = Math.floor(minutes / MINUTES_PER_DAY);
	const hours = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);

	if (days > 0) return `${String(days)}d ${String(hours)}h`;
	if (hours > 0) return `${String(hours)}h ${String(minutes % MINUTES_PER_HOUR)}m`;

	return `${String(minutes)}m`;
};
