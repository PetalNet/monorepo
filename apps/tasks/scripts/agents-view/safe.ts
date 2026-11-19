// Adapted from Claude Code agents-view hooks, 291069fa-3ac4-4e01-939f-5d8782460da4.
// Redact before shortening: truncation must never leave a credential prefix visible.
export function redact(text: string): string {
	return plainText(text)
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
		.replace(/(\/(?:home|Users)\/)[^/\s"'<>:]+/g, "$1[user]")
		.replace(/~[A-Za-z0-9_.-]+(?=\/)/g, "~[user]")
		.replace(/([A-Z]:\\Users\\)[^\\\s"'<>:]+/gi, "$1[user]")
		.replace(/\bBearer\s+[^\s"'`,;<>]+/gi, "Bearer [redacted]")
		.replace(/(?:sk-|gh[pousr]_|github_pat_|AIza|xox[a-z]-)[A-Za-z0-9_-]*/gi, "[redacted]")
		.replace(
			/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
			"$1[redacted]",
		)
		.replace(/\b[0-9a-f]{32,}\b/gi, "[redacted]")
		.replace(/[A-Za-z0-9+/=]{48,}/g, "[redacted]")
		.replace(/[A-Za-z0-9_=-]{48,}/g, "[redacted]");
}

function plainText(text: string): string {
	let state: "text" | "escape" | "csi" | "osc" | "osc-end" = "text";
	let result = "";

	for (const char of text) {
		const code = char.charCodeAt(0);

		if (state === "osc") {
			if (code === 7) state = "text";
			else if (code === 27) state = "osc-end";

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
			if (code >= 64 && code <= 126) state = "text";

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
		)
			continue;

		result += char;
	}

	return result;
}

export function short(text: string, length = 100): string {
	const safe = redact(text).replace(/\s+/g, " ").trim();

	return safe.length > length ? `${safe.slice(0, length - 1)}…` : safe;
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

	return Number.isFinite(n) ? n : 0;
}

export function json(line: string): Record<string, unknown> | null {
	try {
		return record(JSON.parse(line));
	} catch {
		return null;
	}
}

export function content(value: unknown): string {
	if (typeof value === "string") return value;

	if (Array.isArray(value))
		return value
			.map((item) => {
				const block = record(item);

				return string(block.text) || (block.type === "image" ? "[image]" : "");
			})
			.filter(Boolean)
			.join("\n");

	return value === undefined ? "" : JSON.stringify(value);
}

export function prLinks(text: string): string[] {
	return [
		...new Set(
			redact(text).match(
				/https:\/\/(?:github\.com|gitlab\.com)\/[\w.-]+\/[\w.-]+\/(?:pull|merge_requests|[^\s/]+\/merge_requests)\/\d+/g,
			) ?? [],
		),
	];
}

export function byteSize(text: string): number {
	return new TextEncoder().encode(text).length;
}
