import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
	candidateSpans,
	EpisodeStore,
	ingestRecallDb,
	redactBatch,
	sha256Hex,
	sweepResidualSecrets,
	verifyEpisodes,
} from "../src/episodes/index.ts";
import type { EpisodeMetadata } from "../src/episodes/index.ts";
import { Store } from "../src/index.ts";

const stores: Store[] = [];
const dirs: string[] = [];

function tempDir(prefix: string) {
	const dir = mkdtempSync(path.join(process.cwd(), prefix));

	dirs.push(dir);

	return dir;
}

function newStore() {
	const store = new Store(tempDir(".episodes-store-"));

	stores.push(store);

	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) {
		store.close();
	}

	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Builds a recall-index-shaped SQLite db (same FTS5 `messages` table recall-index writes) with the
 * given rows.
 */
function fixtureRecallDb(
	rows: { text: string; role?: string; session?: string; file?: string; uuid?: string }[],
) {
	const dir = tempDir(".episodes-recall-");
	const dbPath = path.join(dir, "recall.db");
	const db = new DatabaseSync(dbPath);

	db.exec(
		"CREATE VIRTUAL TABLE messages USING fts5(text, role UNINDEXED, session UNINDEXED, ts UNINDEXED, uuid UNINDEXED, file UNINDEXED, tokenize='porter unicode61')",
	);

	const insert = db.prepare(
		"INSERT INTO messages(text,role,session,ts,uuid,file) VALUES(?,?,?,?,?,?)",
	);

	rows.forEach((row, index) => {
		insert.run(
			row.text,
			row.role ?? "user",
			row.session ?? "session-a",
			new Date(2026, 9, 27, 0, 0, index).toISOString(),
			row.uuid ?? `uuid-${String(index)}`,
			row.file ?? "/fake/transcript.jsonl",
		);
	});

	db.close();

	return dbPath;
}

function scopeConfigFile(config: { rooms?: string[]; keywords?: string[] }) {
	const dir = tempDir(".episodes-scope-");
	const file = path.join(dir, "scope.json");

	writeFileSync(file, JSON.stringify(config));

	return file;
}

const GENERIC_SECRET = "S3cr3tValueXXXXXXXXXXXXXXXXXXXX";

function metadata(uuid: string, overrides: Partial<EpisodeMetadata> = {}): EpisodeMetadata {
	return {
		schema_version: 1,
		layer: "EPISODE",
		source_type: "transcript",
		access_tier: "PRIVATE",
		agent_id: "test-agent",
		session_id: "session-a",
		role: "user",
		ts: new Date().toISOString(),
		origin_file: "/fake.jsonl",
		origin_uuid: uuid,
		scan_status: "CLEAN",
		redaction_rules: [],
		...overrides,
	};
}

describe("value-scoped redaction", () => {
	it("masks a secret found via rule context in BOTH messages, including one with no triggering context", () => {
		const messageWithContext = { id: "m1", text: `credential: token=${GENERIC_SECRET} saved` };
		const messageBareRecurrence = {
			id: "m2",
			text: `later I pasted ${GENERIC_SECRET} into slack, bare`,
		};

		const { messages } = redactBatch([messageWithContext, messageBareRecurrence], new Set());
		const byId = new Map(messages.map((message) => [message.id, message]));

		expect(byId.get("m1")?.text).not.toContain(GENERIC_SECRET);
		// This is the finding-scoped bug the Part C spike found (plan 971 comment #58):
		// m2's occurrence has no "token=" prefix, so a per-message/per-finding mask
		// would leave it raw. Value-scoped masking (every collected value, every
		// message in the batch) must still catch it.
		expect(byId.get("m2")?.text).not.toContain(GENERIC_SECRET);
		expect(byId.get("m2")?.text).toContain("[REDACTED:generic-api-key]");
	});

	it("masks a secret in a LATER batch via the persisted known-hash set, even with no triggering context", () => {
		const batch1 = [{ id: "b1", text: `token=${GENERIC_SECRET} in batch one` }];
		const first = redactBatch(batch1, new Set());

		expect(first.newHashes.map((entry) => entry.hash)).toContain(sha256Hex(GENERIC_SECRET));

		const knownHashes = new Set(first.newHashes.map((entry) => entry.hash));
		const batch2 = [{ id: "b2", text: `bare mention of ${GENERIC_SECRET}, no prefix this time` }];
		const second = redactBatch(batch2, knownHashes);

		expect(second.messages[0]?.text).not.toContain(GENERIC_SECRET);
		expect(second.messages[0]?.text).toContain("[REDACTED:known-value]");

		// Without the persisted hash (simulating a fresh, unaware batch), the
		// same bare recurrence is NOT caught -- proves the hash set is load-bearing.
		const withoutKnowledge = redactBatch(batch2, new Set());

		expect(withoutKnowledge.messages[0]?.text).toContain(GENERIC_SECRET);
	});
});

describe("episodes ingest", () => {
	it("drops denylisted room messages before redaction or indexing, keeps the rest", () => {
		const store = newStore();
		const recallPath = fixtureRecallDb([
			{ text: "ordinary message one", session: "room-allowed" },
			{ text: "a denied-room message", session: "room-denied" },
			{ text: "ordinary message two, mentions bannedword inline", session: "room-allowed" },
			{ text: "ordinary message three", session: "room-allowed" },
		]);
		const scopePath = scopeConfigFile({ rooms: ["room-denied"], keywords: ["bannedword"] });

		const counts = ingestRecallDb(store, recallPath, { scopeConfigPath: scopePath });

		expect(counts.messagesIn).toBe(4);
		expect(counts.droppedScope).toBe(2);
		expect(counts.indexed).toBe(2);

		const episodes = new EpisodeStore(store);

		expect(episodes.count()).toBe(2);
		expect(episodes.search("bannedword").length).toBe(0);
		expect(episodes.search("ordinary").length).toBe(2);
	});

	it("does not duplicate episodes when re-run against the same db (incremental cursor)", () => {
		const store = newStore();
		const recallPath = fixtureRecallDb([
			{ text: "first message" },
			{ text: "second message" },
			{ text: "third message" },
		]);

		const first = ingestRecallDb(store, recallPath);

		expect(first.indexed).toBe(3);

		const second = ingestRecallDb(store, recallPath);

		expect(second.messagesIn).toBe(0);
		expect(second.indexed).toBe(0);

		const episodes = new EpisodeStore(store);

		expect(episodes.count()).toBe(3);
	});

	it("masks a secret recurring across two separate ingest runs via the persisted hash set", () => {
		const store = newStore();
		const firstDb = fixtureRecallDb([
			{ text: `token=${GENERIC_SECRET} first appearance`, file: "/a.jsonl" },
		]);
		const secondDb = fixtureRecallDb([
			{ text: `a bare, unprefixed ${GENERIC_SECRET} recurrence`, file: "/b.jsonl" },
		]);

		ingestRecallDb(store, firstDb);
		ingestRecallDb(store, secondDb);

		const episodes = new EpisodeStore(store);
		// The secret is a single alnum run, so FTS5's default tokenizer indexes it
		// as one whole token: an exact-token search is a real positive/negative
		// control here, not a coincidence of substring matching.
		const hits = episodes.search(GENERIC_SECRET);

		expect(hits.length).toBe(0);
	});

	it("retroactively masks an earlier BARE occurrence once a later batch, in the same run, proves the value secret", () => {
		// This is the exact gap the real-copy validation run against recall.db
		// found (plan 971): the known-value hash set only grows forward across
		// ascending rowids, so a bare, context-free occurrence that comes BEFORE
		// the batch that first gives the value triggering context can't be
		// masked when its own batch is written. Forcing batchSize:1 makes each
		// message its own batch so the ordering is deterministic.
		const store = newStore();
		const recallPath = fixtureRecallDb([
			{ text: `a bare, unprefixed ${GENERIC_SECRET} mention -- nothing flags it alone` },
			{ text: `token=${GENERIC_SECRET} confirms it is secret, in a later batch` },
		]);

		const counts = ingestRecallDb(store, recallPath, { batchSize: 1 });

		expect(counts.sweepMasked).toBe(1);

		const episodes = new EpisodeStore(store);

		expect(episodes.search(GENERIC_SECRET).length).toBe(0);
		expect(verifyEpisodes(episodes).hits).toBe(0);
	});
});

describe("episodes verify", () => {
	it("exits clean when nothing raw is indexed, and reports a hit when a raw secret slips through", () => {
		const store = newStore();
		const episodes = new EpisodeStore(store);

		episodes.insert(
			"ep-clean",
			{
				schema_version: 1,
				layer: "EPISODE",
				source_type: "transcript",
				access_tier: "PRIVATE",
				agent_id: "test-agent",
				session_id: "session-a",
				role: "user",
				ts: new Date().toISOString(),
				origin_file: "/fake.jsonl",
				origin_uuid: "uuid-clean",
				scan_status: "CLEAN",
				redaction_rules: [],
			},
			"nothing sensitive here",
		);

		episodes.addKnownHashes([{ hash: sha256Hex(GENERIC_SECRET), rule: "generic-api-key" }]);

		const clean = verifyEpisodes(episodes);

		expect(clean.hits).toBe(0);

		// Simulate the exact failure mode verify must catch: a raw secret value
		// (whose hash is already known) ends up in the FTS index.
		episodes.insert(
			"ep-leaked",
			{
				schema_version: 1,
				layer: "EPISODE",
				source_type: "transcript",
				access_tier: "PRIVATE",
				agent_id: "test-agent",
				session_id: "session-a",
				role: "user",
				ts: new Date().toISOString(),
				origin_file: "/fake.jsonl",
				origin_uuid: "uuid-leaked",
				scan_status: "CLEAN",
				redaction_rules: [],
			},
			`oops, raw ${GENERIC_SECRET} leaked through`,
		);

		const dirty = verifyEpisodes(episodes);

		expect(dirty.hits).toBe(1);
		expect(dirty.hitEpisodeIds).toEqual(["ep-leaked"]);
	});
});

// pullfrog's review on the first slice (PR 535) found the known-hash candidate matcher was
// narrower than what the detectors themselves can produce: a known secret could stay
// searchable after the sweep while verify reported zero hits. These three cases are pullfrog's
// own reproductions.
describe("candidateSpans matches every shape a detector can produce", () => {
	it("produces a 16-19 char value even though the old floor required 20+", () => {
		const shortValue = "C".repeat(18);

		expect(candidateSpans(`token=${shortValue} end`).spans).toContain(shortValue);
	});

	it("produces a full dotted JWT as one candidate, not three dot-split fragments", () => {
		// Synthetic, unsigned, not a real token: header {"alg":"HS256"}, payload
		// {"sub":"1234567890"} (the universal JWT-example placeholder subject), and
		// a hand-typed signature segment that verifies against nothing.
		const jwtLike =
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"; // gitleaks:allow

		expect(candidateSpans(`context around ${jwtLike} more context`).spans).toContain(jwtLike);
	});

	it("produces the exact stored value when it is immediately preceded or followed by / + -", () => {
		const value = "D".repeat(27);

		expect(candidateSpans(`see path/${value} for details`).spans).toContain(value);
		expect(candidateSpans(`${value}-suffix-here`).spans).toContain(value);
		expect(candidateSpans(`prefix+${value}`).spans).toContain(value);
	});
});

describe("end to end: pullfrog's exact reproductions (PR 535)", () => {
	// Mirrors pullfrog's own repro steps precisely: redact a message with context and
	// persist its hash, then insert a SECOND message's bare occurrence RAW (bypassing
	// per-batch redaction entirely), to isolate whether the sweep's and verify's
	// candidate matcher -- not ordinary forward propagation within one ingest call --
	// correctly recognizes it. Under the old 20+-char CANDIDATE_RE this value (18
	// chars) was never produced as a candidate at all.
	it("sweep masks a 16-19 char generic value left raw, and verify then finds zero hits", () => {
		const store = newStore();
		const episodes = new EpisodeStore(store);
		const shortValue = "C".repeat(18);

		const first = redactBatch(
			[{ id: "m1", text: `token=${shortValue} first appearance` }],
			new Set(),
		);

		episodes.addKnownHashes(first.newHashes);

		episodes.insert(
			"m1",
			metadata("uuid-1", { scan_status: "MASKED", redaction_rules: ["generic-api-key"] }),
			first.messages[0]?.text ?? "",
		);

		episodes.insert("m2", metadata("uuid-2"), `later, bare: ${shortValue}`);

		const swept = sweepResidualSecrets(episodes);

		expect(swept.swept).toBe(1);
		expect(episodes.search(shortValue).length).toBe(0);
		expect(verifyEpisodes(episodes).hits).toBe(0);
	});

	it("sweep masks a 27 char value left raw and immediately preceded by '/', and verify then finds zero hits", () => {
		const store = newStore();
		const episodes = new EpisodeStore(store);
		const value = "D".repeat(27);

		const first = redactBatch([{ id: "m1", text: `token=${value} first appearance` }], new Set());

		episodes.addKnownHashes(first.newHashes);

		episodes.insert(
			"m1",
			metadata("uuid-1", { scan_status: "MASKED", redaction_rules: ["generic-api-key"] }),
			first.messages[0]?.text ?? "",
		);

		episodes.insert("m2", metadata("uuid-2"), `see path/${value} later, no other context`);

		const swept = sweepResidualSecrets(episodes);

		expect(swept.swept).toBe(1);
		expect(episodes.search(value).length).toBe(0);
		expect(verifyEpisodes(episodes).hits).toBe(0);
	});
});

describe("candidate enumeration fails closed on its own limits (pullfrog round 2, PR 535)", () => {
	// Mirrors pullfrog's second reproduction exactly: a known value that contains ITS OWN
	// internal delimiter ('-'), recurring inside a run with many '/' delimiters. The earlier
	// boundary-sampling fallback could drop the specific boundary pair needed to reconstruct
	// this value byte-for-byte, so it stayed raw while sweep and verify both reported success.
	const value = `${"D".repeat(18)}-${"E".repeat(18)}`;
	const pathologicalRecurrence = `path/${"a/".repeat(60)}${value}/end`;

	it("sweepResidualSecrets quarantines the episode instead of silently passing it", () => {
		const store = newStore();
		const episodes = new EpisodeStore(store);

		const first = redactBatch([{ id: "m1", text: `token=${value} context` }], new Set());

		episodes.addKnownHashes(first.newHashes);

		episodes.insert(
			"m1",
			metadata("uuid-1", { scan_status: "MASKED", redaction_rules: ["generic-api-key"] }),
			first.messages[0]?.text ?? "",
		);

		episodes.insert("m2", metadata("uuid-2"), pathologicalRecurrence);

		const swept = sweepResidualSecrets(episodes);

		expect(swept.quarantined).toBe(1);
		expect(swept.swept).toBe(0);

		const quarantinedMetadata = episodes.getMetadata("m2");

		expect(quarantinedMetadata?.scan_status).toBe("QUARANTINED");
		// Quoted: the value's own embedded "-" is FTS5 query syntax, not a token
		// character, so an unquoted MATCH would be a malformed query here.
		expect(episodes.search(`"${value}"`).length).toBe(0);
		expect(verifyEpisodes(episodes).hits).toBe(0);
	});

	it("redactBatch drops the message at ingest time rather than inserting it raw", () => {
		const first = redactBatch([{ id: "m1", text: `token=${value} context` }], new Set());
		const knownHashes = new Set(first.newHashes.map((entry) => entry.hash));

		const second = redactBatch([{ id: "m2", text: pathologicalRecurrence }], knownHashes);

		expect(second.messages[0]?.text).toBeNull();
	});

	it("verifyEpisodes treats truncated coverage as a hit, never as a clean pass", () => {
		const store = newStore();
		const episodes = new EpisodeStore(store);

		episodes.addKnownHashes([{ hash: sha256Hex(value), rule: "generic-api-key" }]);
		episodes.insert("m2", metadata("uuid-2"), pathologicalRecurrence);

		const result = verifyEpisodes(episodes);

		expect(result.hits).toBe(1);
		expect(result.hitEpisodeIds).toEqual(["m2"]);
	});
});

describe("scope config fails closed", () => {
	it("aborts ingest, writing nothing and advancing no cursor, when an explicitly configured scope path is missing", () => {
		const store = newStore();
		const recallPath = fixtureRecallDb([{ text: "message one" }, { text: "message two" }]);
		const missingPath = path.join(tempDir(".episodes-missing-scope-"), "does-not-exist.json");

		expect(() => ingestRecallDb(store, recallPath, { scopeConfigPath: missingPath })).toThrow();

		const episodes = new EpisodeStore(store);

		expect(episodes.count()).toBe(0);
		expect(episodes.cursor(path.resolve(recallPath))).toBe(0);
	});

	it("does not throw and uses an empty deny list when the scope path is simply unset", () => {
		const store = newStore();
		const recallPath = fixtureRecallDb([{ text: "message one" }]);

		expect(() => ingestRecallDb(store, recallPath, {})).not.toThrow();

		const episodes = new EpisodeStore(store);

		expect(episodes.count()).toBe(1);
	});
});

it("verification agrees with independent exhaustive hashing at delimiter and limit edges", () => {
	const episodes = new EpisodeStore(newStore());
	const value = `${"D".repeat(18)}-${"E".repeat(18)}`;
	const knownHashes = new Set([sha256Hex(value), sha256Hex("F".repeat(15))]);

	episodes.addKnownHashes([...knownHashes].map((hash) => ({ hash, rule: "known-value" })));

	const texts = [
		value,
		`${value}X`,
		`X${value}`,
		...[".", "-", "/", "+", "../"].map(
			(delimiter) => `prefix${delimiter}${value}${delimiter}suffix`,
		),
		...[46, 47, 48, 49, 50].map((count) => `prefix/${"a/".repeat(count)}${value}`),
		"F".repeat(15),
		"F".repeat(14),
	];
	const expected: string[] = [];

	for (const [index, text] of texts.entries()) {
		const id = `reference-${String(index)}`;

		episodes.insert(id, metadata(id), text);
		let hit = false;

		for (const match of text.matchAll(/[A-Za-z0-9_\-/+.]{15,}/g)) {
			const run = match[0];
			const pieces = run.split(/([.\-/+])/);

			if (pieces.length > 97 || knownHashes.has(sha256Hex(run))) {
				hit = true;
			}

			for (let start = 0; start < pieces.length; start += 2) {
				for (let end = start; end < pieces.length; end += 2) {
					const candidate = pieces.slice(start, end + 1).join("");

					if (candidate.length >= 15 && knownHashes.has(sha256Hex(candidate))) {
						hit = true;
					}
				}
			}
		}

		if (hit) {
			expected.push(id);
		}
	}

	expect(verifyEpisodes(episodes).hitEpisodeIds.toSorted()).toEqual(expected.toSorted());
});
