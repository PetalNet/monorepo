import { createHash } from "node:crypto";

import {
	Activity,
	Check,
	Copy,
	HardDrive,
	ShieldCheck,
	Terminal,
	Trash2,
	type IconNode,
} from "lucide";

import { accessTable } from "./policy.ts";
import type { CacheEvents, Storage } from "./stats.ts";

export interface HomeData {
	readonly now: number;
	readonly cacheUp: boolean;
	readonly storage: Storage | null;
	readonly events: CacheEvents;
	readonly build: string;
}

const esc = (value: string | number) =>
	String(value).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
	);

function icon(node: IconNode, label = "") {
	const body = node
		.map(([tag, attrs]) => {
			const pairs = Object.entries(attrs)
				.map(([key, value]) => `${key}="${esc(String(value))}"`)
				.join(" ");

			return `<${tag} ${pairs}/>`;
		})
		.join("");

	return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${body}</svg>`;
}

const gib = 1024 ** 3;

function formatBytes(bytes: number) {
	if (bytes >= gib) {
		return `${(bytes / gib).toFixed(bytes >= 10 * gib ? 1 : 2)} GiB`;
	}

	if (bytes >= 1024 ** 2) {
		return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	}

	return `${String(Math.round(bytes / 1024))} KiB`;
}

function formatAgo(from: number, now: number) {
	const seconds = Math.max(0, Math.round((now - from) / 1000));

	if (seconds < 90) {
		return "moments ago";
	}

	if (seconds < 5400) {
		return `${String(Math.round(seconds / 60))} minutes ago`;
	}

	if (seconds < 36 * 3600) {
		return `${String(Math.round(seconds / 3600))} hours ago`;
	}

	return `${String(Math.round(seconds / 86400))} days ago`;
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const count = (n: number) => n.toLocaleString("en-US");

function storageCard(data: HomeData) {
	const { storage, now } = data;

	if (!storage) {
		return `<section class="card" aria-labelledby="h-storage">
	<h2 id="h-storage">${icon(HardDrive)}Storage</h2>
	<p class="empty">Waiting for the first eviction pass. It runs every five minutes.</p>
</section>`;
	}

	const share = Math.min(1, storage.bytes / storage.max_bytes);
	const evicted =
		storage.last_eviction === null
			? "Nothing has been evicted yet."
			: `${formatAgo(storage.last_eviction * 1000, now)}, ${utc(storage.last_eviction * 1000)}`;
	const lastPass =
		storage.evicted_files > 0
			? `Removed ${count(storage.evicted_files)} files (${formatBytes(storage.evicted_bytes)}) in the latest pass.`
			: "The latest pass removed nothing.";

	return `<section class="card" aria-labelledby="h-storage">
	<h2 id="h-storage">${icon(HardDrive)}Storage</h2>
	<p class="figure"><span class="num">${formatBytes(storage.bytes)}</span> <span class="of">of ${formatBytes(storage.max_bytes)} cap</span></p>
	<div class="meter" role="meter" aria-label="Cache used" aria-valuemin="0" aria-valuemax="${String(storage.max_bytes)}" aria-valuenow="${String(storage.bytes)}"><span class="fill" style="inline-size:${(share * 100).toFixed(1)}%"></span></div>
	<dl class="facts">
		<div><dt>Artifacts</dt><dd>${count(storage.files)}</dd></div>
		<div><dt>Used</dt><dd>${(share * 100).toFixed(1)}% of cap</dd></div>
		<div><dt>Measured</dt><dd>${formatAgo(storage.updated * 1000, now)}</dd></div>
	</dl>
	<h3>${icon(Trash2)}Last eviction</h3>
	<p class="stat">${evicted}</p>
	<p class="note">${lastPass} Passes run every five minutes: least recently used first down to 90% of the cap, and anything idle for 14 days.</p>
</section>`;
}

function trafficCard(data: HomeData) {
	const { events, now } = data;
	const total = events.hit + events.miss;
	const peak = Math.max(1, ...events.hours.map((hour) => hour.hit + hour.miss));
	const rate = total === 0 ? null : (events.hit / total) * 100;
	const bars = events.hours
		.map((hour) => {
			const label = `${new Date(hour.start).toISOString().slice(11, 13)}:00 UTC, ${String(hour.hit)} hits, ${String(hour.miss)} misses`;
			const hit = (hour.hit / peak) * 100;
			const miss = (hour.miss / peak) * 100;

			return `<li title="${esc(label)}"><span class="miss" style="block-size:${miss.toFixed(1)}%"></span><span class="hit" style="block-size:${hit.toFixed(1)}%"></span></li>`;
		})
		.join("");

	return `<section class="card" aria-labelledby="h-traffic">
	<h2 id="h-traffic">${icon(Activity)}Remote cache, last 24 hours</h2>
	${
		rate === null
			? `<p class="empty">No remote lookups reported yet.</p>`
			: `<p class="figure"><span class="num">${rate.toFixed(1)}%</span> <span class="of">hit rate</span></p>`
	}
	<dl class="facts">
		<div><dt>Hits</dt><dd>${count(events.hit)}</dd></div>
		<div><dt>Misses</dt><dd>${count(events.miss)}</dd></div>
		<div><dt>Lookups</dt><dd>${count(total)}</dd></div>
	</dl>
	<ol class="bars" role="img" aria-label="Remote cache lookups per hour over the last 24 hours: ${count(events.hit)} hits and ${count(events.miss)} misses">${bars}</ol>
	<p class="axis"><span>24 hours ago</span><span class="key"><i class="hit"></i>hit <i class="miss"></i>miss</span><span>now</span></p>
	<p class="note">Counted from the lookups Turbo clients report, since ${utc(events.since)} (${formatAgo(events.since, now)}). Local hits never reach the server.</p>
</section>`;
}

export function renderLive(data: HomeData) {
	return `<p class="status ${data.cacheUp ? "up" : "down"}"><span class="dot"></span>${
		data.cacheUp ? "Cache server answering" : "Cache server not answering"
	}</p>
<div class="grid">${storageCard(data)}${trafficCard(data)}</div>`;
}

const tokenCommand = `identity=$(printf %s "$AK_APP_PASSWORD" |
  curl --fail --silent --show-error https://auth.petalcat.dev/application/o/token/ \\
    -d grant_type=password -d client_id=turbo-cache.petalcat.dev -d scope='openid profile' \\
    --data-urlencode username="$AK_USER" --data-urlencode password@- |
  jq -er .access_token) &&
TURBO_TOKEN=$(curl --fail --silent --show-error -X POST -H "Authorization: Bearer $identity" \\
  https://turbo-cache.petalcat.dev/exchange | jq -er .access_token) &&
export TURBO_API=https://turbo-cache.petalcat.dev TURBO_TEAM=petalnet TURBO_TOKEN \\
  TURBO_CACHE=local:rw,remote:r TURBO_REMOTE_CACHE_TIMEOUT=15`;

const prepareCommand = `read -r AK_USER
read -rs AK_APP_PASSWORD
export AK_USER AK_APP_PASSWORD`;

const runCommand = "pnpm turbo run build --cache=remote:r";

function code(text: string) {
	return `<div class="code"><pre><code>${esc(text)}</code></pre><button type="button" class="copy" aria-label="Copy command" data-copy>${icon(Copy)}${icon(Check)}</button></div>`;
}

const css = `
:root{color-scheme:light dark;--paper:#f8f5ef;--surface:#efe9de;--ink:#1d1a16;--muted:#5d554a;--rule:#d9d1c3;--accent:#9c4a1f;--on-accent:#f8f5ef;--ease:cubic-bezier(.16,1,.3,1)}
@media (prefers-color-scheme:dark){:root{--paper:#171410;--surface:#211d18;--ink:#f1ebe0;--muted:#b3a998;--rule:#3a342b;--accent:#e6935f;--on-accent:#171410}}
@font-face{font-family:"Geist Variable";src:url(/assets/geist.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono Variable";src:url(/assets/geist-mono.woff2) format("woff2");font-weight:100 900;font-display:swap}
*{box-sizing:border-box;margin:0}
html{background:var(--paper);color:var(--ink);font:300 1rem/1.6 "Geist Variable",system-ui,sans-serif;hanging-punctuation:first;-webkit-text-size-adjust:100%}
body{padding-block:48px 80px;padding-inline:24px}
main{max-inline-size:1040px;margin-inline:auto}
::selection{background:var(--accent);color:var(--on-accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
h1{font-size:2.5rem;font-weight:400;line-height:1.1;text-wrap:balance}
h2{display:flex;align-items:center;gap:8px;font-size:1rem;font-weight:500;margin-block-end:16px}
h3{display:flex;align-items:center;gap:8px;font-size:.875rem;font-weight:500;margin-block:24px 8px;padding-block-start:24px;background:linear-gradient(var(--rule),var(--rule)) top/100% 1px no-repeat}
.section>h2{font-size:1.5rem;font-weight:400;margin-block-end:8px}
.icon{inline-size:20px;block-size:20px;flex:none;color:var(--accent)}
header p{max-inline-size:65ch;color:var(--muted);margin-block-start:16px}
.status{display:inline-flex;align-items:center;gap:8px;margin-block:24px 24px;font-size:.875rem;color:var(--muted)}
.dot{inline-size:8px;block-size:8px;border-radius:50%;background:var(--accent)}
.down .dot{background:var(--muted)}
.down{color:var(--ink);font-weight:500}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))}
.card{background:var(--surface);border-radius:2px;padding:24px;transition:background-color .2s var(--ease)}
.figure{margin-block-end:16px;line-height:1.2}
.num{font-size:2rem;font-weight:300;font-variant-numeric:tabular-nums}
.of{color:var(--muted)}
.meter{block-size:8px;background:var(--rule);border-radius:2px;overflow:hidden}
.fill{display:block;block-size:100%;background:var(--accent);border-radius:2px}
.facts{display:grid;grid-template-columns:repeat(3,auto);justify-content:space-between;gap:16px;margin-block-start:16px}
dt{font-size:.875rem;color:var(--muted)}
dd{font-variant-numeric:tabular-nums;font-weight:400}
.stat{font-weight:400}
.note,.empty{font-size:.875rem;color:var(--muted);max-inline-size:65ch;margin-block-start:8px}
.empty{font-size:1rem}
.bars{list-style:none;padding:0;display:grid;grid-template-columns:repeat(24,1fr);gap:4px;block-size:96px;margin-block-start:24px;align-items:end}
.bars li{display:flex;flex-direction:column;justify-content:flex-end;block-size:100%;background:linear-gradient(var(--rule),var(--rule)) bottom/100% 1px no-repeat;min-inline-size:0}
.bars span{display:block;inline-size:100%}
.bars .hit,.key .hit{background:var(--accent)}
.bars .miss,.key .miss{background:var(--muted);opacity:.5}
.axis{display:flex;justify-content:space-between;gap:16px;font-size:.75rem;color:var(--muted);margin-block-start:8px}
.key{display:inline-flex;align-items:center;gap:8px}
.key i{display:inline-block;inline-size:8px;block-size:8px;border-radius:2px}
.key i+i{margin-inline-start:8px}
.section{margin-block-start:64px}
.section>p{color:var(--muted);max-inline-size:65ch}
table{inline-size:100%;border-collapse:collapse;margin-block-start:24px}
th{font-size:.875rem;font-weight:400;color:var(--muted);text-align:start}
th,td{padding:16px 24px 16px 0;vertical-align:top;background:linear-gradient(var(--rule),var(--rule)) bottom/100% 1px no-repeat}
td:first-child{font-weight:400;white-space:nowrap}
td:last-child,th:last-child{padding-inline-end:0}
.pill{display:inline-block;padding:0 8px;border-radius:2px;font-size:.875rem;font-weight:500;white-space:nowrap;background:var(--surface)}
.pill.write{background:var(--accent);color:var(--on-accent)}
.pill.denied{background:none;color:var(--muted);padding-inline:0}
ol.steps{list-style:none;padding:0;margin-block-start:24px;display:grid;grid-template-columns:minmax(0,1fr);gap:32px}
.steps>li{max-inline-size:820px}
.steps h3{background:none;padding:0;margin:0 0 8px;font-size:1rem;display:block}
.steps p{color:var(--muted);margin-block-end:8px}
a{color:var(--accent);text-underline-offset:3px}
.code{position:relative;background:var(--surface);border-radius:2px}
pre{overflow-x:auto;padding:16px 56px 16px 16px;font:400 .8125rem/1.6 "Geist Mono Variable",ui-monospace,monospace}
code{font-family:"Geist Mono Variable",ui-monospace,monospace;font-size:.9em}
.copy{position:absolute;inset-block-start:8px;inset-inline-end:8px;display:grid;place-items:center;inline-size:40px;block-size:40px;border:0;border-radius:2px;background:none;color:var(--ink);cursor:pointer;transition:background-color .15s var(--ease)}
.copy:hover{background:var(--rule)}
.copy .icon{grid-area:1/1;color:currentColor;transition:opacity .15s var(--ease)}
.copy .icon+.icon{opacity:0}
.copy.done .icon:first-child{opacity:0}.copy.done .icon+.icon{opacity:1;color:var(--accent)}
footer{margin-block-start:64px;font-size:.875rem;color:var(--muted);padding-block-start:24px;background:linear-gradient(var(--rule),var(--rule)) top/100% 1px no-repeat}
html:not(.live) .fill{animation:grow .8s var(--ease) both}
html:not(.live) .bars li>span{transform-origin:bottom;animation:rise .8s var(--ease) both}
@keyframes grow{from{inline-size:0!important}}
@keyframes rise{from{transform:scaleY(0)}}
@media (max-width:640px){body{padding-block-start:32px;padding-inline:16px}h1{font-size:2rem}.card{padding:16px}.facts{grid-template-columns:1fr 1fr}
table,tbody,tr,td{display:block}thead{position:absolute;inline-size:1px;block-size:1px;overflow:hidden}
tr{padding-block:16px;background:linear-gradient(var(--rule),var(--rule)) bottom/100% 1px no-repeat}td{padding:0;background:none;white-space:normal!important}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

const script = `
const live = document.getElementById("live");
const poll = async () => {
  try {
    const r = await fetch("/_live", { cache: "no-store" });
    if (r.ok) { const html = await r.text(); if (html !== live.dataset.html) { live.innerHTML = html; live.dataset.html = html; } }
  } catch {}
};
setTimeout(() => document.documentElement.classList.add("live"), 1200);
setInterval(poll, 30000);
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.parentElement.querySelector("code").textContent);
    button.classList.add("done");
    setTimeout(() => button.classList.remove("done"), 1500);
  } catch {}
});
`;

const scriptHash = createHash("sha256").update(script).digest("base64");

export const homeHeaders = {
	"content-security-policy": `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"cache-control": "no-store",
};

export function renderHome(data: HomeData) {
	const rows = accessTable
		.map(
			(row) =>
				`<tr><td>${esc(row.identity)}</td><td><span class="pill ${row.access === "denied" ? "denied" : row.access === "read" ? "read" : "write"}">${esc(row.access)}</span></td><td>${esc(row.evidence)}</td></tr>`,
		)
		.join("");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>PetalNet Turbo cache</title>
<link rel="preload" href="/assets/geist.woff2" as="font" type="font/woff2" crossorigin>
<style>${css}</style>
</head>
<body>
<main>
<header>
<h1>PetalNet Turbo cache</h1>
<p>The shared build cache for PetalNet/monorepo. CI writes to it from main and reads from pull requests. Teammates can read it from a checkout.</p>
</header>
<div id="live">${renderLive(data)}</div>

<section class="section" aria-labelledby="h-access">
<h2 id="h-access">${icon(ShieldCheck)}Who can use it</h2>
<p>Every caller trades an identity token for a two-hour cache token. Only a push to main can write.</p>
<table>
<thead><tr><th scope="col">Identity</th><th scope="col">Access</th><th scope="col">Evidence required</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</section>

<section class="section" aria-labelledby="h-connect">
<h2 id="h-connect">${icon(Terminal)}Connect a machine</h2>
<p>Local use is read-only. Ask an administrator to add you to the Authentik group <code>turbo-cache</code>, then open <a href="https://auth.petalcat.dev/if/user/">your Authentik user settings</a> and create an app password under Tokens and App passwords.</p>
<ol class="steps">
<li><h3>Keep the password out of your history</h3>${code(prepareCommand)}</li>
<li><h3>Trade it for a cache token and set the Turbo variables</h3>${code(tokenCommand)}</li>
<li><h3>Run Turbo as usual</h3><p>The token lasts two hours. Repeat the trade for a new one. To see a remote hit, delete a task's output first, for example <code>dist</code>.</p>${code(runCommand)}</li>
</ol>
</section>

<footer>Build ${esc(data.build.slice(0, 7))} · <a href="https://github.com/PetalNet/monorepo/tree/main/apps/turbo-cache">Source and runbook</a> · <a href="/stats.json">stats.json</a></footer>
</main>
<script>${script}</script>
</body>
</html>`;
}
