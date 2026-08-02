// Shared Effect Schema conventions for the console's wire validation. These constants replicate,
// byte for byte, the acceptance behavior the console previously delegated to zod so the Effect
// Schema SSOT (rewrite Phase 4) keeps the exact accept/reject semantics of the old validators.

/**
 * Annotation that makes a `Schema.Struct` reject unknown keys, matching zod's `.strict()`. Effect
 * applies `parseOptions` to the annotated node and its subtree, so a nested struct that must keep
 * the default stripping behavior needs an explicit `{ parseOptions: { onExcessProperty: "ignore" }
 * }`.
 */
export const rejectUnknownKeys = {
	parseOptions: { onExcessProperty: "error" },
} as const;

/** RFC 9562/4122 UUID (any version 1-8, plus nil/max), exactly zod's `z.uuid()`. */
export const UUID_RE =
	/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

// Calendar-aware ISO-8601 date, exactly zod's internal date source (leap years included).
const ISO_DATE_SOURCE =
	"(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";
const ISO_TIME_SOURCE = "(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?";

/** ISO-8601 UTC date-time (`Z` suffix required), exactly zod's `z.iso.datetime()`. */
export const ISO_DATETIME_UTC_RE = new RegExp(`^${ISO_DATE_SOURCE}T(?:${ISO_TIME_SOURCE}(?:Z))$`);

/**
 * ISO-8601 date-time with `Z` or a `±hh:mm` offset, exactly zod's `z.iso.datetime({ offset: true
 * })`.
 */
export const ISO_DATETIME_OFFSET_RE = new RegExp(
	`^${ISO_DATE_SOURCE}T(?:${ISO_TIME_SOURCE}(?:Z|(?:[+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$`,
);
