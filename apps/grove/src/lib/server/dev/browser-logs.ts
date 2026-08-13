import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

export const DEV_BROWSER_LOG_MAX_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 16_384;
const MAX_ENTRIES = 20;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_SOURCE_LENGTH = 100;
const levels = new Set(["error", "warn", "uncaught", "unhandled-rejection"]);

interface BrowserLogEntry {
	readonly level: string;
	readonly message: string;
	readonly source: string;
	readonly timestamp?: string;
}

let pendingWrite = Promise.resolve();

const errorResponse = (status: number, error: string, message: string) =>
	Response.json({ error, message }, { status });

const readBoundedBody = async (request: Request): Promise<string | Response> => {
	const contentLength = request.headers.get("content-length");
	if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES)
		return errorResponse(413, "request_too_large", "Browser log requests must not exceed 16 KiB");
	const reader = request.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let byteLength = 0;
	let body = "";
	try {
		while (true) {
			// A request stream is sequential; every chunk must count toward the hard byte bound.
			// oxlint-disable-next-line no-await-in-loop
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > MAX_REQUEST_BYTES) {
				// oxlint-disable-next-line no-await-in-loop
				await reader.cancel();
				return errorResponse(
					413,
					"request_too_large",
					"Browser log requests must not exceed 16 KiB",
				);
			}
			body += decoder.decode(value, { stream: true });
		}
		body += decoder.decode();
		return body;
	} catch {
		return errorResponse(400, "invalid_body", "Browser log body must be valid UTF-8 JSON");
	} finally {
		reader.releaseLock();
	}
};

const validEntry = (value: unknown): value is BrowserLogEntry => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.level === "string" &&
		levels.has(entry.level) &&
		typeof entry.message === "string" &&
		entry.message.length > 0 &&
		entry.message.length <= MAX_MESSAGE_LENGTH &&
		typeof entry.source === "string" &&
		entry.source.length > 0 &&
		entry.source.length <= MAX_SOURCE_LENGTH &&
		(entry.timestamp === undefined ||
			(typeof entry.timestamp === "string" &&
				entry.timestamp.length <= 40 &&
				!Number.isNaN(Date.parse(entry.timestamp))))
	);
};

const redact = (value: string) =>
	value
		.replace(/\bauthorization\s*[:=]\s*Bearer\s+[^\s,;]+/gi, "authorization=[REDACTED]")
		.replace(/\bBearer\s+[A-Za-z\d._~+/-]+=*/gi, "Bearer [REDACTED]")
		.replace(
			/\b(cookie|password|secret|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
			"$1=[REDACTED]",
		)
		.replace(/[\r\n\t]+/g, " ");

const linesFor = (entries: readonly BrowserLogEntry[]) =>
	entries
		.map((entry) => {
			const timestamp = entry.timestamp ?? new Date().toISOString();
			return `${timestamp} [browser:${entry.level}] ${redact(entry.source)} ${redact(entry.message)}\n`;
		})
		.join("");

const writeBounded = (path: string, lines: string) => {
	const write = pendingWrite.then(async () => {
		await mkdir(dirname(path), { recursive: true });
		const incomingBytes = Buffer.byteLength(lines);
		const currentBytes = await stat(path).then(
			(value) => value.size,
			(error: unknown) => {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
				throw error;
			},
		);
		if (currentBytes + incomingBytes > DEV_BROWSER_LOG_MAX_BYTES) await writeFile(path, "");
		await appendFile(path, lines, { encoding: "utf8", mode: 0o600 });
		return undefined;
	});
	pendingWrite = write.catch(() => undefined);
	return write;
};

export const ingestDevBrowserLogs = async (
	request: Request,
	path = process.env.GROVE_BROWSER_LOG_PATH ??
		resolve(process.cwd(), "../../.amp/in/grove-browser.log"),
) => {
	if (
		request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
		"application/json"
	)
		return errorResponse(415, "unsupported_media_type", "Browser logs must use application/json");
	const body = await readBoundedBody(request);
	if (body instanceof Response) return body;
	let decoded: unknown;
	try {
		decoded = JSON.parse(body) as unknown;
	} catch {
		return errorResponse(400, "invalid_body", "Browser log body must be valid JSON");
	}
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
		return errorResponse(400, "invalid_entries", "Browser log entries are invalid");
	const entries = (decoded as Record<string, unknown>).entries;
	if (
		!Array.isArray(entries) ||
		entries.length === 0 ||
		entries.length > MAX_ENTRIES ||
		!entries.every(validEntry)
	)
		return errorResponse(400, "invalid_entries", "Browser log entries are invalid");
	await writeBounded(path, linesFor(entries));
	return new Response(null, { status: 202 });
};
