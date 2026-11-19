import { describe, expect, it } from "vitest";

import {
	defaultSourceDeps,
	parseCloudflareNeurons,
	readCloudflareAi,
	readGitHubActions,
	sourceConfigFromEnv,
} from "./quota-sources.ts";

const secret = "dummy-secret\nAuthorization: Bearer dummy-key";
const config = sourceConfigFromEnv({ HOME: "/tmp/quota-security" });

describe("quota credential safety", () => {
	it("does not expose malformed credentials from the real HTTP adapter", async () => {
		const deps = {
			...defaultSourceDeps(),
			readFile: () => secret,
			exec: () => Promise.resolve({ code: 0, stdout: secret, stderr: "" }),
		};
		const reports = await Promise.all([
			readCloudflareAi(config, deps),
			readGitHubActions(config, deps),
		]);

		for (const report of reports) {
			expect(report.status).toBe("error");
			expect(JSON.stringify(report)).not.toMatch(/dummy|Authorization|Bearer|https?:/u);
		}
	});

	it("does not expose failed vault command stderr or exception text", async () => {
		const report = await readCloudflareAi(config, {
			...defaultSourceDeps(),
			exec: () =>
				Promise.resolve({
					code: 1,
					stdout: "",
					stderr: secret,
					error: `command failed: https://example.test/?key=dummy-key ${secret}`,
				}),
		});

		expect(report.error).toBe("vault get failed (exit 1)");
		expect(JSON.stringify(report)).not.toMatch(/dummy|Authorization|Bearer|https?:/u);
	});

	it("redacts errors from a real failed vault process", async () => {
		const realDeps = defaultSourceDeps();
		const report = await readCloudflareAi(config, {
			...realDeps,
			exec: (_command, _args, timeoutMs) =>
				realDeps.exec(
					process.execPath,
					[
						"-e",
						'process.stderr.write("Authorization: Bearer dummy-key https://example.test/?key=dummy-key"); process.exit(1);',
					],
					timeoutMs,
				),
		});

		expect(report.error).toBe("vault get failed (exit 1)");
		expect(JSON.stringify(report)).not.toMatch(/dummy|Authorization|Bearer|https?:/u);
	});

	it("does not echo GraphQL error messages", () => {
		const report = parseCloudflareNeurons({ errors: [{ message: secret }] }, "2026-11-19", 10_000);

		expect(report.error).toBe("cloudflare graphql error");
	});
});
