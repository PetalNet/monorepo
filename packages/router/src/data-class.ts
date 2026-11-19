import type { DataClass } from "./pick.ts";

const SECRET_RE =
	/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY/u;

/** A brief carrying a credential is sensitive whatever the flag says; the class only ever rises. */
export function effectiveDataClass(flag: DataClass, brief: string): DataClass {
	if (flag === "parcs" || /\b(?:PARCS|Bridgeton)\b/iu.test(brief)) return "parcs";

	return SECRET_RE.test(brief) ? "sensitive" : flag;
}
