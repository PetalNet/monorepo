/**
 * Payloads phone cameras understand. Both formats use `;` and `:` as separators, so a value that
 * contains one must escape it with a backslash or the phone reads a truncated network name or
 * password.
 */

const SPECIAL = /[\\;,:"]/g;

/** Escape `\ ; , : "` with a backslash, as the Wi-Fi and MECARD formats require. */
export const escapeQrValue = (value: string): string => value.replaceAll(SPECIAL, "\\$&");

export type WifiSecurity = "WPA" | "WEP" | "nopass";

/**
 * A Wi-Fi join payload. Phones that scan it offer to join the network. WPA covers WPA2 and WPA3
 * personal networks too.
 */
export function wifiJoin(ssid: string, password: string, security: WifiSecurity = "WPA"): string {
	const secret = security === "nopass" ? "" : `P:${escapeQrValue(password)};`;

	return `WIFI:T:${security};S:${escapeQrValue(ssid)};${secret};`;
}

/** A MECARD contact. Phones that scan it offer to save the contact. */
export function meCard(contact: { name: string; phone: string; email: string }): string {
	const parts = [
		`N:${escapeQrValue(contact.name)}`,
		`TEL:${escapeQrValue(contact.phone)}`,
		`EMAIL:${escapeQrValue(contact.email)}`,
	];

	return `MECARD:${parts.join(";")};;`;
}
