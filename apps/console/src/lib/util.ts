/** Small shared UI helpers. */

/** First letter of a name, for avatar/initial chips. */
export function initial(handle: string): string {
	return (handle[0] ?? "?").toUpperCase();
}
