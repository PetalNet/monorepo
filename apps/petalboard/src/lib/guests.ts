/** A guest can bring up to this many named people (the party tops out at 20 with the guest). */
export const MAX_PLUS_ONES = 19;
export const MAX_PLUS_ONE_NAME_LENGTH = 100;

/** RSVPs made before +1s had names keep a bare guestCount, so some of the party may be unnamed. */
export function unnamedGuests(guestCount: number, guestNames: readonly string[]): number {
	return Math.max(0, guestCount - 1 - guestNames.length);
}

/** "Sam", "Sam and Alex", "Sam, Alex and Jo", "Sam and 2 more" when part of the party is unnamed. */
export function partyLabel(guestCount: number, guestNames: readonly string[]): string {
	const unnamed = unnamedGuests(guestCount, guestNames);
	const parts = unnamed > 0 ? [...guestNames, `${unnamed} more`] : [...guestNames];

	if (parts.length <= 1) {
		return parts[0] ?? "";
	}

	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
