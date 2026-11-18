#!/usr/bin/env node
// Rebuild Janet's home page (/janet/home) from live lab facts. Janet runs it on a systemd
// user timer on 202 (scripts/systemd/); each run replaces the whole document with set_home.
//
//   node scripts/janet-lab-status.mjs [--print]
//
// --print writes the markdown to stdout and posts nothing. Otherwise it posts to
// $TASKS_URL (default https://tasks.petalcat.dev) using the unscoped write token in
// $JANET_HOME_TOKEN or the file $JANET_HOME_TOKEN_FILE (default ~/.config/janet-home/token).
//
// Facts: .14 (docker host) over one ssh call for disk, load and container state; 202 (this box)
// from the kernel and systemd --user. Hosts are shown as ".14" and "202" and nothing else:
// no addresses, tokens or personal data. Running Claude Code sessions are counted on 202 only;
// agentsview would know about every machine but needs auth, so it is not used here. Every
// external call has a deadline.
import { execFile } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { fileURLToPath } from "node:url";

const DOCKER_HOST_SSH = "docker@10.10.10.14";
const TIMEOUT_MS = 15_000;

const run = (cmd, args) =>
	new Promise((resolve) => {
		execFile(cmd, args, { timeout: TIMEOUT_MS, encoding: "utf8" }, (err, stdout) =>
			resolve(err ? null : stdout),
		);
	});

// ── .14: one ssh call, three sections ────────────────────────────────────────
const REMOTE =
	"echo @@df; df -P /; echo @@load; cat /proc/loadavg; echo @@ps; docker ps --format '{{.Names}}\t{{.Status}}'";

export function parseDockerHost(out) {
	if (!out) {
		return { up: false };
	}

	const sec = Object.fromEntries(
		out
			.split("@@")
			.slice(1)
			.map((s) => {
				const [name, ...rest] = s.split("\n");

				return [name.trim(), rest.join("\n")];
			}),
	);
	const dfLine = (sec.df ?? "").trim().split("\n")[1]?.trim().split(/\s+/);
	const load = Number.parseFloat((sec.load ?? "").split(" ")[0]);
	const containers = new Map(
		(sec.ps ?? "")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => l.split("\t"))
			.map(([name, status]) => [name, /^Up/.test(status ?? "") && !/unhealthy/.test(status)]),
	);

	if (!dfLine || dfLine.length < 5 || Number.isNaN(load)) {
		return { up: false };
	}

	return {
		up: true,
		freeBytes: Number(dfLine[3]) * 1024,
		usedPct: Number.parseInt(dfLine[4], 10),
		load,
		containers,
	};
}

// ── 202: local ───────────────────────────────────────────────────────────────
function localHost() {
	const s = statfsSync("/");

	return {
		up: true,
		freeBytes: s.bavail * s.bsize,
		usedPct: Math.round(100 * (1 - s.bavail / s.blocks)),
		load: loadavg()[0],
	};
}

const unitActive = async (unit) =>
	(await run("systemctl", ["--user", "is-active", unit]))?.trim() === "active";

async function claudeSessions() {
	const out = await run("pgrep", ["-f", "^(.*/)?claude( |$)"]);

	return out ? out.trim().split("\n").filter(Boolean).length : 0;
}

export async function collect() {
	const [remote, head, gateway, sessions] = await Promise.all([
		run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", DOCKER_HOST_SSH, REMOTE]).then(
			parseDockerHost,
		),
		unitActive("janet-voice-head.service"),
		unitActive("janet-voice-gateway.service"),
		claudeSessions(),
	]);
	const c = remote.containers;
	const ct = (name) => (remote.up ? Boolean(c.get(name)) : false);

	return {
		hosts: [
			{ name: ".14 docker host", ...remote },
			{ name: "202 (Janet)", ...localHost() },
		],
		services: [
			["Tasks", ct("tasks")],
			["Matrix (synapse)", ct("synapse")],
			["agentsview", ct("agentsview")],
			["Janet phone bridge", ct("janet-phone")],
			["Janet voice head (202)", head],
			["Janet voice gateway (202)", gateway],
		],
		sessions,
	};
}

// ── render ───────────────────────────────────────────────────────────────────
const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const state = (up) => (up ? "up" : "**down**");

export function render({ hosts, services, sessions }) {
	const rows = hosts.map((h) =>
		h.up
			? `| ${h.name} | up | ${gb(h.freeBytes)} free | ${h.load.toFixed(1)} |`
			: `| ${h.name} | **down** | n/a | n/a |`,
	);
	const bad = hosts.filter((h) => !h.up).length + services.filter(([, up]) => !up).length;

	return [
		`# ${bad === 0 ? "Lab is fine" : `Lab: ${bad} thing${bad === 1 ? "" : "s"} down`}`,
		"",
		"## Hosts",
		"",
		"| Host | State | Disk | Load |",
		"|---|---|---|---|",
		...rows,
		"",
		"## Services",
		"",
		"| Service | State |",
		"|---|---|",
		...services.map(([n, up]) => `| ${n} | ${state(up)} |`),
		"",
		"## Claude Code",
		"",
		`${sessions} session${sessions === 1 ? "" : "s"} running on 202.`,
		"",
	].join("\n");
}

// ── post ─────────────────────────────────────────────────────────────────────
async function post(markdown) {
	const file = process.env.JANET_HOME_TOKEN_FILE ?? `${homedir()}/.config/janet-home/token`;
	const token = process.env.JANET_HOME_TOKEN ?? readFileSync(file, "utf8").trim();
	const res = await fetch(
		`${process.env.TASKS_URL ?? "https://tasks.petalcat.dev"}/api/agent/rpc`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ op: "set_home", args: { markdown } }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		},
	);

	if (!res.ok) {
		throw new Error(`set_home failed: HTTP ${res.status}`);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const md = render(await collect());

	if (process.argv.includes("--print")) {
		process.stdout.write(md);
	} else {
		await post(md);
	}
}
