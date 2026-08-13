import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeDevBrowserLogValue } from "../src/lib/dev-browser-logs";
import {
	DEV_BROWSER_LOG_MAX_BYTES,
	ingestDevBrowserLogs,
} from "../src/lib/server/dev/browser-logs";

const temporaryDirectories: string[] = [];
const logPath = async () => {
	const directory = await mkdtemp(join(tmpdir(), "grove-browser-log-"));
	temporaryDirectories.push(directory);
	return join(directory, "grove-browser.log");
};

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Grove development browser logs", () => {
	it("structurally sanitizes browser values before serialization without erasing useful fields", () => {
		const headers = new Headers({
			authorization: `Basic ${Buffer.from("operator:basic-secret").toString("base64")}`,
			"x-api-key": "api-key-secret",
			"x-request-id": "request-123",
		});
		const serialized = serializeDevBrowserLogValue({
			message: "request failed",
			headers,
			credential: "private-credential",
			password: "hidden-password",
			nested: {
				clientSecret: "client-secret-value",
				sessionId: "session-secret-value",
				access_token: "access-token-value",
			},
			url: "https://api.example/items?page=2&api_key=query-secret&X-Amz-Signature=signed-secret",
		});

		expect(serialized).toContain("request failed");
		expect(serialized).toContain("request-123");
		expect(serialized).toContain("page=2");
		expect(serialized).toContain("[REDACTED]");
		for (const secret of [
			"basic-secret",
			"api-key-secret",
			"private-credential",
			"hidden-password",
			"client-secret-value",
			"session-secret-value",
			"access-token-value",
			"query-secret",
			"signed-secret",
		])
			expect(serialized).not.toContain(secret);
	});

	it("redacts credentials embedded in console text", () => {
		const serialized = serializeDevBrowserLogValue(
			"Authorization: Bearer bearer-value authorization=Basic YmFzaWM6dmFsdWU= " +
				"x-api-key=api-value credential: credential-value " +
				"https://api.example/path?token=query-value&requestId=visible-request",
		);

		expect(serialized).toContain("visible-request");
		for (const secret of [
			"bearer-value",
			"YmFzaWM6dmFsdWU=",
			"api-value",
			"credential-value",
			"query-value",
		])
			expect(serialized).not.toContain(secret);
	});

	it("uses server chronology and writes terminal-safe redacted lines", async () => {
		const path = await logPath();
		const before = Date.now();
		const response = await ingestDevBrowserLogs(
			new Request("https://grove.test/__dev/logs/browser", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					entries: [
						{
							level: "unhandled-rejection",
							message:
								"fetch failed\n\tAuthorization: Basic should-not-reach-disk x-api-key=api-secret " +
								"credential=credential-secret https://api.example/path?session=session-secret&request=kept " +
								"\u001b[31mred\u0000nul\bbackspace\u0085c1\u202Espoof\u2066isolate",
							source: "window.unhandledrejection\u001b[2J",
							timestamp: "1999-12-31T23:59:59.000Z",
						},
					],
				}),
			}),
			path,
		);

		expect(response.status).toBe(202);
		const contents = await readFile(path, "utf8");
		expect(contents.split("\n").filter(Boolean)).toHaveLength(1);
		const timestamp = contents.slice(0, contents.indexOf(" "));
		expect(Date.parse(timestamp)).toBeGreaterThanOrEqual(before);
		expect(Date.parse(timestamp)).toBeLessThanOrEqual(Date.now());
		expect(contents).not.toContain("1999-12-31");
		expect(contents).toContain(
			"[browser:unhandled-rejection] window.unhandledrejection fetch failed\\n\\t",
		);
		expect(contents).toContain("request=kept");
		expect(contents).toContain("[REDACTED]");
		for (const secret of [
			"should-not-reach-disk",
			"api-secret",
			"credential-secret",
			"session-secret",
		])
			expect(contents).not.toContain(secret);
		for (const character of contents) {
			const codePoint = character.codePointAt(0) ?? 0;
			expect(
				codePoint <= 0x08 ||
					(codePoint >= 0x0b && codePoint <= 0x0c) ||
					(codePoint >= 0x0e && codePoint <= 0x1f) ||
					(codePoint >= 0x7f && codePoint <= 0x9f) ||
					(codePoint >= 0x202a && codePoint <= 0x202e) ||
					(codePoint >= 0x2066 && codePoint <= 0x2069),
			).toBe(false);
		}
	});

	it("rejects oversized and malformed requests before writing", async () => {
		const path = await logPath();
		const oversized = await ingestDevBrowserLogs(
			new Request("https://grove.test/__dev/logs/browser", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "x".repeat(16_385),
			}),
			path,
		);
		const malformed = await ingestDevBrowserLogs(
			new Request("https://grove.test/__dev/logs/browser", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ entries: [{ level: "info", message: "not accepted" }] }),
			}),
			path,
		);

		expect(oversized.status).toBe(413);
		expect(malformed.status).toBe(400);
		await expect(stat(path)).rejects.toThrow();
	});

	it("rotates the stable file before it can exceed its bound", async () => {
		const path = await logPath();
		await writeFile(path, `old-marker${"x".repeat(DEV_BROWSER_LOG_MAX_BYTES)}`);

		const response = await ingestDevBrowserLogs(
			new Request("https://grove.test/__dev/logs/browser", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					entries: [{ level: "warn", message: "new bounded event", source: "console.warn" }],
				}),
			}),
			path,
		);

		expect(response.status).toBe(202);
		expect((await stat(path)).size).toBeLessThanOrEqual(DEV_BROWSER_LOG_MAX_BYTES);
		const contents = await readFile(path, "utf8");
		expect(contents).toContain("new bounded event");
		expect(contents).not.toContain("old-marker");
	});
});
