// Adapted from Claude Code agents-view hooks, 291069fa-3ac4-4e01-939f-5d8782460da4.
// Redact before shortening: truncation must never leave a credential prefix visible.
// Provider token patterns align with gitleaks / packages/vault-engine/src/secrets.ts.
const PEM_BLOCK =
	/-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----|$)/g;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi;
const QUOTED_AUTH =
	/(\b(?:proxy-)?authorization["']?\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?)(["'`])((?:\\[^\r\n]|(?!\2)[^\\\r\n])+?)\2/gi;
const UNQUOTED_AUTH =
	/(\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[^\s"',;<>`]+/gi;
const PROVIDER_TOKEN =
	/(?<![A-Za-z0-9_-])(?:(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b|(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|xox[a-z]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]+|(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]+|AIza[A-Za-z0-9_-]+|npm_[A-Za-z0-9]{36}\b|pypi-AgEIcHlwaS5vcmc[\w-]+|SG\.[\w=-]{16,}\.[\w=-]{16,}|SK[0-9a-fA-F]{32}\b|\d{8,10}:AA[\w-]{33}\b|(?:syt|mat|mct)_[\w=-]{6,}_[\w=-]{10,}(?:_[\w=-]{4,})?|tskey-[a-z]+-[\w-]+|AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b|hf_[A-Za-z0-9]{20,}|eyJ[\w-]+\.eyJ[\w-]+\.[\w=-]*|eyJ[\w-]+\.[\w-]+\.[\w=-]+)/g;
const QUOTED_ASSIGNMENT =
	/(\b(?:[\w-]*(?:token|secret|password|passwd|passphrase)|[\w-]+[_-](?:key|pwd)|api[_-]?key)["'`]?\s*(?:=|:|=>|:=)\s*)(["'`])((?:\\[^\r\n]|(?!\2)[^\\\r\n])+?)\2/gi;
const UNQUOTED_ASSIGNMENT =
	/(\b(?:[\w-]*(?:token|secret|password|passwd|passphrase)|[\w-]+[_-](?:key|pwd)|api[_-]?key)["'`]?\s*(?:=|:|=>|:=)\s*["'`]?)[^\s"'`,;}]+/gi;

export function redact(text: string): string {
	return plainText(text)
		.replace(PEM_BLOCK, "[redacted]")
		.replace(URL_CREDENTIALS, "$1[redacted]@")
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
		.replace(/(\/(?:home|Users)\/)[^/\s"'<>:]+/g, "$1[user]")
		.replace(/~[A-Za-z0-9_.-]+(?=\/)/g, "~[user]")
		.replace(/([A-Z]:\\Users\\)[^\\\s"'<>:]+/gi, "$1[user]")
		.replace(QUOTED_AUTH, "$1$2[redacted]$2")
		.replace(UNQUOTED_AUTH, "$1[redacted]")
		.replace(/\bBearer\s+[^\s"'`,;<>]+/gi, "Bearer [redacted]")
		.replace(
			/((?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s"'<>]+/gi,
			"$1[redacted]",
		)
		.replace(
			/((?:https?:\/\/)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)[^\s"'<>]+/gi,
			"$1[redacted]",
		)
		.replace(/\botpauth:\/\/\S+/gi, "[redacted]")
		.replace(PROVIDER_TOKEN, "[redacted]")
		.replace(QUOTED_ASSIGNMENT, "$1$2[redacted]$2")
		.replace(UNQUOTED_ASSIGNMENT, "$1[redacted]")
		.replace(/\b[0-9a-f]{32,}\b/gi, "[redacted]")
		.replace(/[A-Za-z0-9+/=]{48,}/g, "[redacted]")
		.replace(/[A-Za-z0-9_=-]{48,}/g, "[redacted]");
}

function plainText(text: string): string {
	let state: "text" | "escape" | "csi" | "osc" | "osc-end" = "text";
	let result = "";

	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;

		if (state === "osc") {
			if (code === 7) {
				state = "text";
			} else if (code === 27) {
				state = "osc-end";
			}

			continue;
		}

		if (state === "osc-end") {
			state = char === "\\" ? "text" : "osc";

			continue;
		}

		if (state === "escape") {
			state = char === "[" ? "csi" : char === "]" ? "osc" : "text";

			continue;
		}

		if (state === "csi") {
			if (code >= 64 && code <= 126) {
				state = "text";
			}

			continue;
		}

		if (code === 27) {
			state = "escape";

			continue;
		}

		if (
			(code < 32 && code !== 9 && code !== 10) ||
			code === 127 ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			continue;
		}

		result += char;
	}

	return result;
}

export function clamp(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function short(text: string, length = 100): string {
	const safe = redact(text).replace(/\s+/g, " ").trim();

	return clamp(safe, length);
}

export function body(text: string, limit = 16000): string {
	const safe = redact(text);

	return safe.length > limit ? `${safe.slice(0, limit)}\n[Excerpt truncated.]` : safe;
}

export function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function time(value: unknown): number {
	const n = number(value) ?? Date.parse(string(value));

	return Number.isFinite(n) && n > 0 ? n : 0;
}

export function json(line: string): Record<string, unknown> | null {
	try {
		return record(JSON.parse(line));
	} catch {
		return null;
	}
}

export function content(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (Array.isArray(value)) {
		return value
			.map((item) => {
				const block = record(item);

				return string(block.text) || (block.type === "image" ? "[image]" : "");
			})
			.filter(Boolean)
			.join("\n");
	}

	return value === undefined ? "" : JSON.stringify(value);
}

export function prLinks(text: string): string[] {
	const matches = redact(text).match(
		/https:\/\/(?:github\.com|gitlab\.com)\/[\w.-]+\/[\w.-]+\/(?:pull|merge_requests|[\w.-]+\/merge_requests)\/\d+/g,
	);

	return [...new Set(matches)].filter((link) => link.length <= 1024);
}

export function byteSize(text: string): number {
	return new TextEncoder().encode(text).length;
}
