/**
 * Payloads phone cameras understand. Both formats use `;` and `:` as separators, so a value that
 * contains one must escape it with a backslash or the phone reads a truncated network name or
 * password.
 */

const SPECIAL = /[\\;,:"]/g;

/** Escape `\ ; , : "` with a backslash, as the Wi-Fi and MECARD formats require. */
export const escapeQrValue = (value: string): string => value.replaceAll(SPECIAL, "\\$&");
