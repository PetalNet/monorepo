import { DOTS_PER_MM, TAPES, type TapeWidthMm } from "$lib/doc";

/** Physical cassette width; "4" is the 3.5 mm tape. */
export const tapeMmActual = (width: TapeWidthMm): number => (width === 4 ? 3.5 : width);

/**
 * The tape across its width in dots, and the blank tape on each side of the printable band, so the
 * strip on screen has the cassette's true proportions.
 */
export function tapeAcross(width: TapeWidthMm): { dots: number; gutter: number } {
	const dots = Math.max(TAPES[width].pins, tapeMmActual(width) * DOTS_PER_MM);

	return { dots, gutter: (dots - TAPES[width].pins) / 2 };
}
