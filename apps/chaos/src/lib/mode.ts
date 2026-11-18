/** The visitor's theme choice. "auto" follows the device. */
export const MODES = ["auto", "light", "dark"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_COOKIE = "mode";

export function parseMode(value: string | undefined): Mode {
	return MODES.find((mode) => mode === value) ?? "auto";
}
