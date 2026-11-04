import { readFileSync } from "node:fs";

import { env } from "$env/dynamic/private";
import { canRead } from "$lib/server/db.js";
import { take } from "$lib/server/ratelimit.js";
import { json } from "@sveltejs/kit";

// Hard cap on text the proxy will forward to the PAID ElevenLabs key. The reader only
// ever sends the rendered task body (client clamps to 4800), so a generous-but-bounded
// 6000 char ceiling kills cost-abuse while never truncating a legit Listen.
const MAX_TEXT = 6000;

// ElevenLabs text-to-speech for the reader's "listen" button.
// Key resolution: $ELEVEN_API_KEY, else /data/eleven-api-key (the mounted data dir).
// No key → 503, and the client quietly falls back to the browser's Web Speech API.
function apiKey() {
	if (env.ELEVEN_API_KEY) {
		return env.ELEVEN_API_KEY.trim();
	}

	try {
		return readFileSync("/data/eleven-api-key", "utf8").trim() || null;
	} catch {
		return null;
	}
}

// Whitelisted voices are configured as comma-separated name=id pairs.
const VOICES = Object.fromEntries(
	(env.ELEVEN_VOICES || "")
		.split(",")
		.map((pair) => pair.split("=").map((part) => part.trim()))
		.filter(([name, id]) => name && id),
);

function resolveVoice(pick) {
	return VOICES[pick] || VOICES.default || Object.values(VOICES)[0] || null;
}

export async function POST({ request, params, locals }) {
	// 1. AUTH GATE — fail closed. hooks.server.js already 403s unauthenticated requests in
	//    production (ALLOW set); this is defense-in-depth so the paid-key proxy is NEVER
	//    reachable without an identity, even if the global gate is ever misconfigured/in dev.
	const me = locals.user;

	if (!me) {
		return json({ error: "unauthorized" }, { status: 401 });
	}

	// 2. IDOR / scope — this route is /task/[id]/tts. Only let a caller drive the proxy for
	//    a task they can actually see (private tasks are owner-only). 404 (don't reveal
	//    existence), matching the load-gate. Bad/missing id -> 404 too.
	const id = Number(params.id);

	if (!Number.isInteger(id) || !canRead(id, me)) {
		return json({ error: "not-found" }, { status: 404 });
	}

	// No key configured -> 503 (client quietly falls back to Web Speech). Checked before the
	// rate-limiter so a keyless deploy doesn't burn anyone's quota.
	const key = apiKey();

	if (!key) {
		return json({ error: "no-tts-key" }, { status: 503 });
	}

	// BODY-SIZE GUARD — reject an oversized request BEFORE buffering/parsing the JSON, so a
	// huge body can't pressure the process (DoS). Belt-and-suspenders with a reverse-proxy
	// body limit; MAX_TEXT is chars, allow generous JSON/UTF-8 overhead.
	const clen = Number(request.headers.get("content-length") || 0);

	if (clen > MAX_TEXT * 4 + 1024) {
		return json({ error: "too-long", max: MAX_TEXT }, { status: 413 });
	}

	let pick = "",
		text = "";

	try {
		({ text, voice: pick } = await request.json());
	} catch {}

	text = String(text || "").trim();

	if (!text) {
		return json({ error: "empty" }, { status: 400 });
	}

	// 4. INPUT CAP — reject (not silently truncate) oversized input so a huge body can't run
	//    up cost AND the caller knows their request was refused.
	if (text.length > MAX_TEXT) {
		return json({ error: "too-long", max: MAX_TEXT }, { status: 413 });
	}

	// 3. RATE-LIMIT — charged HERE, after validation, so malformed/empty/oversized requests
	//    can't drain a user's bucket (only a genuine, about-to-bill request spends a token).
	//    Per-user bucket (the cost ceiling) + a global bucket (so the whole account can't be
	//    drained by N users at once). Per-user checked FIRST and short-circuits: an already
	//    throttled user must not keep draining the shared global bucket. Note: this in-process
	//    bucket is sized for the app's single-instance deployment (better-sqlite3, one node
	//    process); a multi-replica rollout would need a shared store to keep the ceiling exact.
	const perUser = take(`tts:user:${me}`, { capacity: 8, rate: 8 / 60 }); // ~8 burst, 1 / 7.5s sustained
	const limited = perUser.ok
		? (() => {
				const global = take("tts:global", { capacity: 30, rate: 30 / 60 }); // ~30 burst, 1 / 2s sustained

				return global.ok ? null : global;
			})()
		: perUser;

	if (limited) {
		return json(
			{ error: "rate-limited" },
			{ status: 429, headers: { "retry-after": String(limited.retryAfter) } },
		);
	}

	const voice = resolveVoice(String(pick || "default").toLowerCase());
	if (!voice) {
		return json({ error: "no-tts-voice" }, { status: 503 });
	}
	// Bound the upstream call — a stalled ElevenLabs request shouldn't tie up the process
	// (or complete a billable request) indefinitely.
	const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
		method: "POST",
		headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
		body: JSON.stringify({
			text,
			model_id: "eleven_turbo_v2_5",
			voice_settings: { stability: 0.5, similarity_boost: 0.75 },
		}),
		signal: AbortSignal.timeout(30_000),
	}).catch(() => null);

	if (!r) {
		return json({ error: "tts-upstream", status: 504 }, { status: 502 });
	}

	if (!r.ok) {
		return json({ error: "tts-upstream", status: r.status }, { status: 502 });
	}

	return new Response(r.body, {
		headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
	});
}
