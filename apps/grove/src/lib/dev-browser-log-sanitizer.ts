const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

const sensitiveKey = (key: string) =>
	/(?:authorization|cookie|password|passwd|credential|secret|token|session|apikey|signature)/i.test(
		key.replace(/[^a-z\d]/gi, ""),
	);

const sensitiveQueryParameter = (key: string) =>
	sensitiveKey(key) || /^(?:auth|code|key|sig)$/i.test(key.replace(/[^a-z\d]/gi, ""));

const unsafeTerminalCodePoint = (codePoint: number) =>
	codePoint <= 0x08 ||
	(codePoint >= 0x0b && codePoint <= 0x0c) ||
	(codePoint >= 0x0e && codePoint <= 0x1f) ||
	(codePoint >= 0x7f && codePoint <= 0x9f) ||
	(codePoint >= 0x202a && codePoint <= 0x202e) ||
	(codePoint >= 0x2066 && codePoint <= 0x2069);

const terminalSafe = (value: string) => {
	let safe = "";
	for (let index = 0; index < value.length; ) {
		const codePoint = value.codePointAt(index) ?? 0;
		const character = String.fromCodePoint(codePoint);
		if (codePoint === 0x1b && value[index + 1] === "[") {
			index += 2;
			while (index < value.length) {
				const ansiCodePoint = value.codePointAt(index) ?? 0;
				index += String.fromCodePoint(ansiCodePoint).length;
				if (ansiCodePoint >= 0x40 && ansiCodePoint <= 0x7e) break;
			}
			continue;
		}
		index += character.length;
		if (codePoint === 0x0d) {
			if (value[index] === "\n") index += 1;
			safe += "\\n";
		} else if (codePoint === 0x0a) safe += "\\n";
		else if (codePoint === 0x09) safe += "\\t";
		else if (!unsafeTerminalCodePoint(codePoint)) safe += character;
	}
	return safe;
};

const sanitizedUrl = (candidate: string) => {
	const relative = candidate.startsWith("/");
	try {
		const url = new URL(candidate, "https://grove.invalid");
		url.username = "";
		url.password = "";
		for (const key of url.searchParams.keys()) {
			if (sensitiveQueryParameter(key)) url.searchParams.set(key, REDACTED);
		}
		return relative ? `${url.pathname}${url.search}${url.hash}` : url.href;
	} catch {
		return candidate;
	}
};

const sanitizeUrlsInText = (value: string) =>
	value.replace(/https?:\/\/[^\s<>"']+/giu, (candidate) => {
		const trailing = /[),.;:!?\]}]+$/u.exec(candidate)?.[0] ?? "";
		const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
		return `${sanitizedUrl(url)}${trailing}`;
	});

const sensitiveAssignment =
	/(?:["']?[a-z\d_.-]*(?:api[-_.]?key|authorization|cookie|password|passwd|credential|secret|token|session|signature)[a-z\d_.-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/giu;

export const sanitizeDevBrowserLogText = (value: string) => {
	const safe = terminalSafe(value);
	return sanitizeUrlsInText(safe)
		.replace(
			/(\b(?:proxy[- ]?)?authorization\b\s*[:=]\s*)(?:Basic|Bearer)\s+[^\s,;]+/giu,
			`$1${REDACTED}`,
		)
		.replace(/\b(Basic|Bearer)\s+[A-Za-z\d._~+/-]{4,}=*/giu, `$1 ${REDACTED}`)
		.replace(sensitiveAssignment, (assignment) => {
			const separator = assignment.search(/[:=]/u);
			return separator < 0 ? REDACTED : `${assignment.slice(0, separator + 1)}${REDACTED}`;
		});
};

const sanitizeValue = (value: unknown, seen: WeakSet<object>, depth: number): unknown => {
	if (typeof value === "string")
		return sanitizeDevBrowserLogText(
			/^https?:\/\//iu.test(value) || value.startsWith("/") ? sanitizedUrl(value) : value,
		);
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "undefined"
	)
		return value;
	if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function")
		return sanitizeDevBrowserLogText(String(value));
	if (value instanceof Error)
		return sanitizeDevBrowserLogText(`${value.name}: ${value.message}\n${value.stack ?? ""}`);
	if (value instanceof URL) return sanitizedUrl(value.href);
	if (value instanceof Date) return value.toISOString();
	if (depth >= MAX_DEPTH) return "[Truncated]";
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (value instanceof Headers)
		return Object.fromEntries(
			[...value.entries()].map(([key, entry]) => [
				key,
				sensitiveKey(key) ? REDACTED : sanitizeDevBrowserLogText(entry),
			]),
		);
	if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, seen, depth + 1));
	if (value instanceof Map)
		return Object.fromEntries(
			[...value.entries()].map(([key, entry]) => {
				const stringKey = String(key);
				return [
					sanitizeDevBrowserLogText(stringKey),
					sensitiveKey(stringKey) ? REDACTED : sanitizeValue(entry, seen, depth + 1),
				];
			}),
		);
	if (value instanceof Set) return [...value].map((entry) => sanitizeValue(entry, seen, depth + 1));
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			sanitizeDevBrowserLogText(key),
			sensitiveKey(key) ? REDACTED : sanitizeValue(entry, seen, depth + 1),
		]),
	);
};

export const sanitizeDevBrowserLogValue = (value: unknown) =>
	sanitizeValue(value, new WeakSet<object>(), 0);
