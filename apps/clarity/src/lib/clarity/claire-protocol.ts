/* Claire protocol — the pure, framework-free half of the AI answer client:
   the SSE wire types, the event reader, URL safety, query eligibility, and the
   per-query snapshot persistence. claire.svelte.ts layers the runes state
   machine on top; everything here is directly unit-testable. */

export interface ClaireSource {
	id: number;
	url: string;
	domain: string;
	title: string;
	fetched: boolean;
}
export interface ClaireSentence {
	text: string;
	cites: number[];
	entail: number;
}
export interface Snap {
	v: 1;
	state: "done" | "abstain" | "consent";
	route: "local" | "cloud";
	sentences: ClaireSentence[];
	sources: ClaireSource[];
	dropped: number;
	cached: boolean;
	ms: number;
	reason: string; // abstain reason ('' otherwise)
	message: string; // abstain / consent message ('' otherwise)
}
export interface ClaireOpts {
	enabled: boolean;
	newTab: boolean;
	priv: boolean;
}

export const hasDom = () => typeof window !== "undefined";

/* backend URLs become hrefs — only http(s) may ever be a link (a javascript: URL must die here) */
export const safeHref = (u: string): string | null => {
	try {
		const proto = new URL(u).protocol;

		return proto === "http:" || proto === "https:" ? u : null;
	} catch {
		return null;
	}
};

/* stable anonymous session id — lets answerd's (benign-only) memory tiers work per device */
export function sid(): string {
	if (!hasDom()) return "anon";

	try {
		let s = localStorage.getItem("clarity-claire-session");

		if (!s) {
			s = crypto.randomUUID();
			localStorage.setItem("clarity-claire-session", s);
		}

		return s;
	} catch {
		return "anon";
	}
}

/* quiet phase labels for the pipeline's status events */
export const PHASE_LABELS: Record<string, string> = {
	"cache-hit": "from cache",
	retrieving: "searching",
	grounding: "reading sources",
	reranking: "weighing evidence",
	generating: "writing",
	coalesced: "joining a matching search",
};

/* a query Claire should sit out: too short, a bang (redirects), or calculator territory */
export function ineligible(q: string): boolean {
	if (q.length < 3) return true;

	if (/(^|\s)!{1,2}[a-z0-9_]+/i.test(q)) return true; // !bang

	if (/[-+*/^=]\s*\d|\d\s*[-+*/^=]/.test(q)) return true; // arithmetic → the calc card owns it

	if (/\b(to|in|as)\b/i.test(q) && /\d\s*[a-zµ°$€£%]/i.test(q)) return true; // unit conversion → Numbat

	return false;
}

/* ---- per-query snapshots (memory + sessionStorage) — restores on back/refine
   without re-spending rate quota. Module-level like the vanilla client. ---- */
const SNAP_KEY = "clarity:claire:";
const snaps = new Map<string, Snap>();

/** Memory-only snapshot (consent answers are session-specific — never sessionStorage). */
export function saveSnapMemory(q: string, s: Snap): void {
	snaps.set(q, s);
}

export function saveSnap(q: string, s: Snap): void {
	snaps.set(q, s);

	try {
		sessionStorage.setItem(SNAP_KEY + q, JSON.stringify(s));
	} catch {
		/* storage full/blocked: in-memory copy still works */
	}
}

export function loadSnap(q: string): Snap | null {
	const m = snaps.get(q);

	if (m) return m;

	if (!hasDom()) return null;

	try {
		const s = sessionStorage.getItem(SNAP_KEY + q);
		const p = s ? (JSON.parse(s) as Snap) : null;

		return p?.v === 1 ? p : null;
	} catch {
		return null;
	}
}

/** Test hook — wipe the in-memory snapshot cache. */
export function clearSnaps(): void {
	snaps.clear();
}

/** Parse one SSE response body; bails silently when the caller's epoch moves on. */
export async function readSse(
	res: Response,
	isCurrent: () => boolean,
	onEvent: (type: string, d: Record<string, unknown>) => void,
): Promise<void> {
	const reader = res.body!.getReader();
	const dec = new TextDecoder();
	let buf = "";

	for (;;) {
		const { done, value } = await reader.read();

		if (!isCurrent()) return;

		if (done) break;

		buf += dec.decode(value, { stream: true });
		let i;

		while ((i = buf.indexOf("\n\n")) >= 0) {
			const chunk = buf.slice(0, i);

			buf = buf.slice(i + 2);

			let ev = "message",
				data = "";

			for (const line of chunk.split("\n")) {
				if (line.startsWith("event:")) ev = line.slice(6).trim();
				else if (line.startsWith("data:")) data += line.slice(5).trim();
			}

			if (!data) continue; // ": keepalive" comments

			try {
				onEvent(ev, JSON.parse(data) as Record<string, unknown>);
			} catch {
				/* malformed frame: skip */
			}
		}
	}
}
