#!/usr/bin/env node
// Janet's home page: set_home / get_home over the real agent-API handler, the sanitized
// view the page renders, and the SSE stream behind /janet/home/events (live push, keepalive
// comments, clean shutdown). Temp DB, plain node, same pattern as test-agent-api.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const TMP = mkdtempSync(path.join(tmpdir(), "janet-home-test-"));

process.env.TASKS_DB_PATH = path.join(TMP, "tasks.db");

const { mintAgentToken } = await import("../src/lib/server/db.js");
const { handleAgentRpc } = await import("../src/lib/server/agent-api.js");
const { parseDockerHost, render } = await import("./janet-lab-status.mjs");
const { homeView, homeStream } = await import("../src/lib/server/home.js");

const rpc = (token, op, args = {}) =>
	handleAgentRpc({ authorization: `Bearer ${token}`, rawBody: JSON.stringify({ op, args }) });
const mint = (opts) => {
	const t = mintAgentToken({ agent_name: opts.name, ...opts });

	return typeof t === "string" ? t : t.token;
};

const writer = mint({ name: "janet", readonly: false });
const reader = mint({ name: "reader", readonly: true });
const lane = mint({ name: "lane", readonly: false, scope_assignee: "someone" });

try {
	// empty before first write
	assert.deepEqual(rpc(writer, "get_home").body, { markdown: "", updated_at: null });

	// set then get round-trips, replacing whole
	const set = rpc(writer, "set_home", { markdown: "# Lab\n\nall **up**" });

	assert.equal(set.status, 200);
	assert.match(set.body.updated_at, /^\d{4}-\d\d-\d\dT/);
	assert.equal(rpc(writer, "get_home").body.markdown, "# Lab\n\nall **up**");
	rpc(writer, "set_home", { markdown: "second" });
	assert.equal(rpc(writer, "get_home").body.markdown, "second");

	// bad input, read-only and lane-scoped tokens, no token
	assert.equal(rpc(writer, "set_home", { markdown: 5 }).status, 400);
	assert.equal(rpc(writer, "set_home", { markdown: "x".repeat(30_000) }).status, 400);
	assert.equal(rpc(reader, "set_home", { markdown: "nope" }).status, 403);
	assert.equal(rpc(reader, "get_home").status, 200);
	assert.equal(rpc(lane, "set_home", { markdown: "nope" }).status, 404);
	assert.equal(rpc(lane, "get_home").status, 404);
	assert.equal(rpc("garbage", "get_home").status, 401);
	assert.equal(rpc(writer, "get_home").body.markdown, "second");

	// what the page renders: markdown works, scripts and handlers never survive
	rpc(writer, "set_home", {
		markdown:
			"## Hosts\n\n| a | b |\n|---|---|\n| x | y |\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[go](javascript:alert(1))",
	});

	const { html, updated_at } = homeView();

	assert.match(html, /<h2[^>]*>Hosts<\/h2>/);
	assert.match(html, /<table>/);
	assert.doesNotMatch(html, /<script|onerror|javascript:/i);
	assert.ok(updated_at);

	// SSE: current doc on connect, a new event per set, keepalives while idle, closes on abort
	const ac = new AbortController();
	const rd = homeStream(ac.signal, { keepaliveMs: 40 }).getReader();
	const dec = new TextDecoder();
	let buf = "";
	let pending = null;
	const until = async (re, ms = 2000) => {
		const deadline = Date.now() + ms;

		while (!re.test(buf)) {
			assert.ok(Date.now() < deadline, `timed out waiting for ${re}; got ${buf}`);

			pending ??= rd.read();

			// oxlint-disable-next-line no-await-in-loop
			const r = await Promise.race([pending, sleep(100, null)]);

			if (r) {
				pending = null;
				buf += dec.decode(r.value ?? new Uint8Array());
			}
		}
	};

	await until(/event: home\ndata: .*"html":"[^"]*<h2/s);
	await until(/: ka\n\n/);
	rpc(writer, "set_home", { markdown: "live update" });
	await until(/data: .*live update/);
	ac.abort();

	const end = await Promise.race([rd.read(), sleep(1000, "hung")]);

	assert.ok(end === "hung" ? false : end.done, "stream closes after abort");

	// an already-aborted request never leaves a listener or timer behind
	const dead = new AbortController();

	dead.abort();
	assert.ok((await homeStream(dead.signal, { keepaliveMs: 10 }).getReader().read()).done);

	// lab-status generator: parses a real-shaped ssh reply, flags what is down, leaks nothing
	const up = parseDockerHost(
		"@@df\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 400000000 360000000 22000000 95% /\n@@load\n10.95 9.36 8.07 25/9583 1\n@@ps\ntasks\tUp 2 days\nsynapse\tUp 3 hours (healthy)\nagentsview\tUp 1 hour (unhealthy)\n",
	);

	assert.equal(up.up, true);
	assert.equal(up.usedPct, 95);
	assert.equal(up.load, 10.95);
	assert.equal(up.containers.get("tasks"), true);
	assert.equal(up.containers.get("agentsview"), false);
	assert.equal(parseDockerHost(null).up, false);
	// docker daemon down: the host is still up, just with no containers
	const noDocker = parseDockerHost("@@df\nH\n/dev/x 4 3 1 75% /\n@@load\n0.5 0 0 1/1 1\n@@ps\n");

	assert.equal(noDocker.up, true);
	assert.equal(noDocker.containers.size, 0);
	assert.equal(parseDockerHost("garbage").up, false);

	const facts = {
		hosts: [
			{ name: ".14 docker host", ...up },
			{ name: "202 (Janet)", up: true, freeBytes: 5.5 * 1024 ** 3, usedPct: 96, load: 2 },
		],
		services: [
			["Tasks", true],
			["Matrix (synapse)", false],
		],
		sessions: 1,
	};
	const md = render(facts);

	assert.match(md, /^# Lab: 1 thing down/);
	assert.match(md, /\| Matrix \(synapse\) \| \*\*down\*\* \|/);
	assert.match(md, /\| \.14 docker host \| up \| 21\.0 GB free \| 10.9 \|/);
	assert.match(md, /1 session running on 202/);
	assert.doesNotMatch(md, /\d+\.\d+\.\d+\.\d+|token|secret/i);

	assert.match(
		render({ ...facts, services: [["Tasks", true]], hosts: [facts.hosts[1]] }),
		/^# Lab is fine/,
	);

	assert.match(
		render({ ...facts, hosts: [{ name: ".14 docker host", up: false }] }),
		/\*\*down\*\* \| n\/a/,
	);

	console.log("janet-home: ok");
} finally {
	rmSync(TMP, { recursive: true, force: true });
}
