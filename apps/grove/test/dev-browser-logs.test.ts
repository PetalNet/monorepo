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
	it("serializes useful errors while redacting sensitive keys and bearer credentials", () => {
		const serialized = serializeDevBrowserLogValue({
			message: "request failed",
			headers: { authorization: "Bearer browser-secret-token", cookie: "session=private" },
			password: "hidden-password",
		});

		expect(serialized).toContain("request failed");
		expect(serialized).toContain("[REDACTED]");
		expect(serialized).not.toContain("browser-secret-token");
		expect(serialized).not.toContain("session=private");
		expect(serialized).not.toContain("hidden-password");
	});

	it("accepts bounded structured entries and writes one sanitized line per event", async () => {
		const path = await logPath();
		const response = await ingestDevBrowserLogs(
			new Request("https://grove.test/__dev/logs/browser", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					entries: [
						{
							level: "unhandled-rejection",
							message:
								"fetch failed\nauthorization=Bearer should-not-reach-disk cookie=session-secret",
							source: "window.unhandledrejection",
							timestamp: "2026-08-13T00:00:00.000Z",
						},
					],
				}),
			}),
			path,
		);

		expect(response.status).toBe(202);
		const contents = await readFile(path, "utf8");
		expect(contents.split("\n").filter(Boolean)).toHaveLength(1);
		expect(contents).toContain(
			"2026-08-13T00:00:00.000Z [browser:unhandled-rejection] window.unhandledrejection fetch failed",
		);
		expect(contents).toContain("[REDACTED]");
		expect(contents).not.toContain("should-not-reach-disk");
		expect(contents).not.toContain("session-secret");
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
