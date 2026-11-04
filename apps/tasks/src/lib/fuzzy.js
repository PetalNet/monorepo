// fzf/nucleo-style fuzzy matcher — no dependency. Greedy left-to-right subsequence
// match with bonus scoring (word boundaries, consecutive runs, prefix) and a gap
// penalty, plus the matched character positions so the UI can highlight them.
//
// This mirrors what nucleo/fzf reward: a query is a match iff every query char appears
// in order; the score then favors matches at word starts and tight consecutive runs.

const BONUS_BOUNDARY = 16; // match right after a separator / at a word start
const BONUS_START = 24; // match at index 0
const BONUS_CONSECUTIVE = 10; // immediately follows the previous match
const PENALTY_GAP = 2; // per skipped char between matches
const PENALTY_GAP_MAX = 12;

const SEP = /[\s/_\-.:#()[\]]/;

function isBoundary(prev, ch) {
	if (prev === "") return true;
	if (SEP.test(prev)) return true;
	// camelCase boundary: lower→Upper
	if (prev.toLowerCase() === prev && ch.toUpperCase() === ch && ch.toLowerCase() !== ch)
		return true;
	// digit boundary: letter→digit
	if (/[a-z]/i.test(prev) && /[0-9]/.test(ch)) return true;
	return false;
}

// Returns { score, positions } or null if `query` is not a subsequence of `text`.
export function fuzzyScore(query, text) {
	const q = String(query || "").toLowerCase();
	if (!q) return { score: 0, positions: [] };
	if (!text) return null;
	const t = String(text);
	const tl = t.toLowerCase();

	let qi = 0;
	let score = 0;
	let prevMatch = -2;
	const positions = [];

	for (let i = 0; i < tl.length && qi < q.length; i++) {
		if (tl[i] !== q[qi]) continue;
		let s = 1;
		const prev = i > 0 ? t[i - 1] : "";
		if (i === 0) s += BONUS_START;
		else if (isBoundary(prev, t[i])) s += BONUS_BOUNDARY;
		if (i === prevMatch + 1) s += BONUS_CONSECUTIVE;
		else if (prevMatch >= 0) s -= Math.min(PENALTY_GAP * (i - prevMatch - 1), PENALTY_GAP_MAX);
		score += s;
		positions.push(i);
		prevMatch = i;
		qi++;
	}

	if (qi < q.length) return null; // not every query char matched, in order
	// a leading gap (query doesn't start the string) costs a little; shorter text wins ties
	score -= positions[0] * 0.5;
	score -= t.length * 0.04;
	return { score, positions };
}

// Rank a task index against a query. Scores the title (primary), project name (×0.4),
// and assignee (×0.3); a numeric query also strongly matches the task #id. Returns the
// top `limit` items, each annotated with { _score, _hits } (title match positions).
export function rankTasks(query, index, limit = 8) {
	const q = String(query || "").trim();
	if (!q) return [];
	const numeric = /^#?\d+$/.test(q);
	const numQ = numeric ? q.replace("#", "") : null;
	const out = [];

	for (const it of index) {
		const title = it.title || "";
		const tm = fuzzyScore(q, title);
		let best = tm ? tm.score : -Infinity;
		let hits = tm ? tm.positions : [];

		const pm = it.project ? fuzzyScore(q, it.project) : null;
		if (pm && pm.score * 0.4 > best) {
			best = pm.score * 0.4;
			hits = tm ? tm.positions : [];
		}

		const am = it.assignee ? fuzzyScore(q, it.assignee) : null;
		if (am && am.score * 0.3 > best) best = Math.max(best, am.score * 0.3);

		if (numQ) {
			const idStr = String(it.id);
			if (idStr === numQ) best = Math.max(best, 1000);
			else if (idStr.startsWith(numQ)) best = Math.max(best, 600);
		}

		if (best > -Infinity) out.push({ ...it, _score: best, _hits: hits });
	}

	out.sort((a, b) => b._score - a._score || (b.updated_at || "").localeCompare(a.updated_at || ""));
	return out.slice(0, limit);
}

// Split `text` into { text, hit } chunks given matched positions, for <mark> highlighting.
export function highlightChunks(text, positions) {
	const t = String(text || "");
	if (!positions || !positions.length) return [{ text: t, hit: false }];
	const set = new Set(positions);
	const chunks = [];
	let buf = "";
	let cur = set.has(0);
	for (let i = 0; i < t.length; i++) {
		const hit = set.has(i);
		if (hit !== cur) {
			if (buf) chunks.push({ text: buf, hit: cur });
			buf = "";
			cur = hit;
		}
		buf += t[i];
	}
	if (buf) chunks.push({ text: buf, hit: cur });
	return chunks;
}
