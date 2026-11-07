#!/usr/bin/env node
// Behaviour test for error-report scrubbing. Drives the REAL Sentry SDK and its SvelteKit
// handle with the app's sentryOptions, captures the envelope through an in-memory transport,
// and checks that planted fake credentials never reach it. A control run without the scrub
// proves the same credentials do reach the transport, so a pass is not an empty capture.
import assert from "node:assert/strict";

import * as Sentry from "@sentry/sveltekit";

import { sentryOptions } from "../src/lib/telemetry.js";

const PLANTED = {
	authorization: "PLANTED_BEARER",
	cookie: "PLANTED_COOKIE",
	proxySecret: "PLANTED_PROXY",
	identity: "planted-user",
	share: "PLANTEDSHARE",
	param: "PLANTED_SIG",
};

const checks = [];

async function t(name, fn) {
	try {
		await fn();
		checks.push({ name, pass: true });
	} catch (error) {
		checks.push({ name, pass: false, detail: error.message });
	}
}

// Run one failing request through sentryHandle and return the captured error event.
async function capture(options) {
	const bodies = [];

	// Scopes outlive Sentry.init, so each run starts without the previous run's breadcrumbs.
	for (const scope of [
		Sentry.getGlobalScope(),
		Sentry.getIsolationScope(),
		Sentry.getCurrentScope(),
	]) {
		scope.clear();
	}

	Sentry.init({
		...options,
		dsn: "http://public@127.0.0.1:1/1",
		enabled: true,
		transport: (transportOptions) =>
			Sentry.createTransport(transportOptions, async (request) => {
				bodies.push(
					typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body),
				);

				return { statusCode: 200 };
			}),
	});

	const url = `http://tasks.test/s/${PLANTED.share}?sig=${PLANTED.param}&view=1`;
	const request = new Request(url, {
		headers: {
			authorization: `Bearer ${PLANTED.authorization}`,
			cookie: `session=${PLANTED.cookie}`,
			"x-authentik-username": PLANTED.identity,
			"x-term-proxy-secret": PLANTED.proxySecret,
			"user-agent": "telemetry-test",
		},
	});
	const event = {
		request,
		url: new URL(url),
		route: { id: "/s/[token]" },
		params: { token: PLANTED.share },
		locals: {},
		cookies: { get: () => undefined, getAll: () => [] },
		getClientAddress: () => "127.0.0.1",
		isDataRequest: false,
		isSubRequest: false,
		platform: undefined,
		setHeaders() {},
	};

	Sentry.addBreadcrumb({ category: "fetch", data: { url, method: "GET" } });

	await assert.rejects(
		Sentry.sentryHandle()({
			event,
			resolve: () => {
				throw new Error("telemetry-test failure");
			},
		}),
	);

	await Sentry.flush(2000);
	await Sentry.close(2000);

	const events = bodies
		.flatMap((body) => body.split("\n"))
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		})
		.filter((item) => item.exception);

	assert.equal(events.length, 1, "exactly one error event is captured");

	return events[0];
}

const leaks = (event) => {
	const json = JSON.stringify(event);

	return Object.values(PLANTED).filter((value) => json.includes(value));
};

const control = await capture({ tracesSampleRate: 0 });
const scrubbed = await capture(sentryOptions({ dsn: "unused", environment: "test" }));

await t("control: without the scrub the planted credentials reach the transport", () => {
	assert.ok(leaks(control).includes(PLANTED.authorization), "bearer reaches an unscrubbed event");
	assert.ok(leaks(control).includes(PLANTED.cookie), "cookie reaches an unscrubbed event");
	assert.ok(leaks(control).includes(PLANTED.share), "share token reaches an unscrubbed event");
});

await t("scrubbed event carries none of the planted credentials", () => {
	assert.deepEqual(leaks(scrubbed), []);
});

await t("scrubbed event drops cookies and credential headers", () => {
	assert.equal(scrubbed.request.cookies, undefined);

	const names = Object.keys(scrubbed.request.headers ?? {}).map((name) => name.toLowerCase());

	assert.ok(!names.includes("authorization"));
	assert.ok(!names.includes("cookie"));
	assert.ok(!names.some((name) => name.startsWith("x-")), "no x-* headers");
});

await t("scrubbed event keeps what is useful for debugging", () => {
	assert.equal(scrubbed.exception.values[0].value, "telemetry-test failure");
	assert.equal(scrubbed.request.method, "GET");
	assert.equal(scrubbed.request.headers["user-agent"], "telemetry-test");
	assert.match(scrubbed.request.url, /^http:\/\/tasks\.test\/s\/\[redacted\]\?/u);
	assert.match(scrubbed.request.url, /view=1/u);
});

await t("breadcrumb URLs are scrubbed", () => {
	const urls = (scrubbed.breadcrumbs ?? []).map((crumb) => crumb.data?.url).filter(Boolean);

	assert.ok(urls.length > 0, "the planted breadcrumb is present");

	for (const url of urls) {
		assert.ok(!url.includes(PLANTED.share) && !url.includes(PLANTED.param), url);
	}
});

let failed = 0;

for (const c of checks) {
	console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : ` — ${c.detail}`}`);

	if (!c.pass) {
		failed++;
	}
}

console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
