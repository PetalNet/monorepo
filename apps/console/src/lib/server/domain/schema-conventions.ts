// The shared wire-validation conventions now live with the browser-safe contract modules so both
// the client bundle ($lib/api, $lib/contracts) and the server domain share one definition. This
// module remains the server-side import point.
export {
	ISO_DATETIME_OFFSET_RE,
	ISO_DATETIME_UTC_RE,
	rejectUnknownKeys,
	UUID_RE,
} from "../../contracts/schema-conventions.ts";
