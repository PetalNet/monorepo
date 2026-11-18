import { createHash, randomBytes } from "node:crypto";
import os from "node:os";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { LoroDoc } from "loro-crdt";
import type { Value } from "loro-crdt";

import { SecretFound, TierUnreadable, WriteRejected } from "./errors.ts";
import { Claim, Source, Topic, tiers } from "./schema.ts";
import type { Link, Tier } from "./schema.ts";
import { secretRules } from "./secrets.ts";
import { TierFiles } from "./store.ts";

/** One tier as readers see it: every record whole, keyed by its own ID. */
export interface TierState {
	readonly claims: Record<string, Claim>;
	readonly sources: Record<string, Source>;
	readonly topics: Record<string, Topic>;
}

/**
 * How a tier is laid out inside its Loro document. Every map holds plain values keyed by ID. A Loro
 * map keeps one writer's value per key, so anything two replicas may write at the same time has its
 * own key: each passage is its own entry, addressed by a hash of its text.
 */
interface Stored {
	claims: Record<string, Claim>;
	sources: Record<string, Omit<Source, "passages" | "headings">>;
	passages: Record<string, { text: string; heading?: string }>;
	topics: Record<string, Topic>;
}

export type NewClaim = Pick<Claim, "text" | "topic" | "heading" | "links" | "sourceType">;

export type NewSource = Omit<Source, "agent">;

export interface Located {
	readonly tier: Tier;
	readonly kind: "claims" | "sources";
}

/** Every tier at one moment, with lookups across them. */
export interface VaultView {
	readonly tiers: Readonly<Record<Tier, TierState>>;
	/** Which tier holds a claim or source. */
	readonly locate: (id: string) => Located | undefined;
	readonly source: (id: string) => Source | undefined;
}

/** One write on one tier. Each method stages a checked record; the transaction commits them all. */
export interface Tx extends VaultView {
	readonly tier: Tier;
	/** The write time, as an ISO string. */
	readonly now: string;
	/** This tier as staged so far. */
	readonly state: TierState;
	readonly addClaim: (input: NewClaim) => Effect.Effect<Claim, WriteRejected | SecretFound>;
	/** A passage is what a claim was checked against, so its text never changes once written. */
	readonly putSource: (input: NewSource) => Effect.Effect<Source, WriteRejected | SecretFound>;
	/**
	 * Adds a quoted passage and returns its ID: a hash of the text, so two replicas quoting the same
	 * source never hand different passages the same ID.
	 */
	readonly addPassage: (
		source: string,
		text: string,
		heading?: string,
	) => Effect.Effect<string, WriteRejected | SecretFound>;
	readonly putTopic: (input: Topic) => Effect.Effect<Topic, WriteRejected | SecretFound>;
}

export type VaultError = PlatformError | TierUnreadable;

export interface VaultShape {
	readonly root: string;
	/** The writing agent. Each agent on each host writes as its own Loro peer. */
	readonly agent: string;
	readonly file: (tier: Tier) => string;
	readonly view: Effect.Effect<VaultView, VaultError>;
	/**
	 * Runs one write under the tier's lock. It commits only if every operation passed its checks and
	 * no claim was lost.
	 */
	readonly transact: <A, E, R>(
		tier: Tier,
		message: string,
		body: (tx: Tx) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | WriteRejected | SecretFound | VaultError, R>;
	readonly snapshot: (tier: Tier) => Effect.Effect<Uint8Array, VaultError>;
}

export interface VaultConfig {
	readonly root: string;
	readonly agent: string;
	/** Names this host in the writer's peer; defaults to the hostname. */
	readonly host?: string;
}

const reject = (message: string) => new WriteRejected({ message });
const passageKey = (source: string, passage: string) => `${source}#${passage}`;
const isClaimId = (id: string) => id.startsWith("c-");
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function readState(doc: LoroDoc): TierState {
	const stored = Object.fromEntries(
		["claims", "sources", "passages", "topics"].map((name) => [
			name,
			doc.getMap(name).toJSON() as unknown,
		]),
	) as unknown as Stored;
	const sources: Record<string, Source> = {};

	for (const [id, core] of Object.entries(stored.sources)) {
		sources[id] = { ...core, passages: {} };
	}

	// Loro does not keep insertion order; passages read back in ID order (s2 before s10).
	const ordered = Object.entries(stored.passages).toSorted(([a], [b]) =>
		a.localeCompare(b, "en", { numeric: true }),
	);

	for (const [key, passage] of ordered) {
		const [sourceId = "", id = ""] = key.split("#");
		const source = sources[sourceId];

		if (source) {
			sources[sourceId] = {
				...source,
				passages: { ...source.passages, [id]: passage.text },
				...(passage.heading === undefined
					? {}
					: { headings: { ...source.headings, [id]: passage.heading } }),
			};
		}
	}

	return { claims: stored.claims, sources, topics: stored.topics };
}

/** Every string in a value, keys included, as written: JSON escaping would hide token boundaries. */
function strings(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}

	if (Array.isArray(value)) {
		return value.flatMap((item) => strings(item));
	}

	if (typeof value === "object" && value !== null) {
		return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
	}

	return [];
}

const refuseSecrets = (value: unknown, where: string) => {
	const rules = secretRules(strings(value));

	return rules.length === 0 ? Effect.void : Effect.fail(new SecretFound({ rules, where }));
};

const checked = <A>(schema: Schema.Decoder<A>, value: unknown) =>
	// Strict: a record key the schema does not know, even one a record schema would drop, is refused.
	Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
		Effect.mapError((error) => reject(error.message)),
	);

// A shared-tier record must not point into a private tier: the shared projection would name it.
const mayLink = (from: Tier, to: Tier) => to === from || to === "shared";

function makeView(states: Readonly<Record<Tier, TierState>>): VaultView {
	const locate = (id: string): Located | undefined => {
		const kind = isClaimId(id) ? "claims" : "sources";
		const tier = tiers.find((each) => id in states[each][kind]);

		return tier === undefined ? undefined : { tier, kind };
	};

	return {
		tiers: states,
		locate,
		source: (id) => {
			const found = locate(id);

			return found?.kind === "sources" ? states[found.tier].sources[id] : undefined;
		},
	};
}

function makeTx(
	tier: Tier,
	doc: LoroDoc,
	committed: Readonly<Record<Tier, TierState>>,
	agent: string,
	now: string,
): Tx {
	const base = committed[tier];
	const state = {
		claims: { ...base.claims },
		sources: { ...base.sources },
		topics: { ...base.topics },
	};
	const view = makeView({ ...committed, [tier]: state });

	/**
	 * The one way a transaction writes: the record is checked against its schema, then the stored
	 * value is set in the document and the record staged for later reads in this write. Secrets are
	 * caught at commit, where everything the write added to the op log is scanned.
	 */
	const write = Effect.fnUntraced(function* <A extends { readonly id: string }>(
		kind: keyof TierState,
		schema: Schema.Decoder<A>,
		record: unknown,
		map: keyof Stored,
		key: string,
		stored: object,
	) {
		const valid = yield* checked(schema, record);

		// The JSON round trip drops undefined-valued keys, which Loro refuses.
		// oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone keeps them.
		doc.getMap(map).set(key, JSON.parse(JSON.stringify(stored)) as Value);
		(state[kind] as Record<string, unknown>)[valid.id] = valid;

		return valid;
	});

	const source = (id: string) => {
		const found = state.sources[id];

		return found
			? Effect.succeed(found)
			: Effect.fail(reject(`Source ${id} is not in the ${tier} tier`));
	};

	const checkLinks = Effect.fnUntraced(function* (links: readonly Link[]) {
		for (const link of links) {
			const found = view.locate(link.target);

			if (!found) {
				return yield* reject(`Link target ${link.target} is not in the vault`);
			}

			if (!mayLink(tier, found.tier)) {
				return yield* reject(
					`A ${tier} claim cannot link to ${link.target} in the ${found.tier} tier`,
				);
			}

			if (
				link.passage !== undefined &&
				!(link.passage in (view.source(link.target)?.passages ?? {}))
			) {
				return yield* reject(`Passage ${link.target}#^${link.passage} does not exist`);
			}
		}
	});

	const newClaimId = () => {
		for (;;) {
			const id = `c-${BigInt(`0x${randomBytes(8).toString("hex")}`)
				.toString(36)
				.padStart(8, "0")
				.slice(-8)}`;

			if (!view.locate(id)) {
				return id;
			}
		}
	};

	const addClaim = Effect.fnUntraced(function* (input: NewClaim) {
		if (!(input.topic in state.topics)) {
			return yield* reject(`Topic ${input.topic} is not in the ${tier} tier`);
		}

		yield* checkLinks(input.links);

		const core = { ...input, id: newClaimId(), created: now, agent };

		return yield* write("claims", Claim, core, "claims", core.id, core);
	});

	const passage = Effect.fnUntraced(function* (
		current: Source,
		id: string,
		text: string,
		heading: string | undefined,
	) {
		if (current.passages[id] === text) {
			return;
		}

		yield* write(
			"sources",
			Source,
			{
				...current,
				passages: { ...current.passages, [id]: text },
				...(heading === undefined ? {} : { headings: { ...current.headings, [id]: heading } }),
			},
			"passages",
			passageKey(current.id, id),
			{ text, ...(heading === undefined ? {} : { heading }) },
		);
	});

	return {
		...view,
		tier,
		now,
		state,
		addClaim,
		putSource: Effect.fnUntraced(function* (input: NewSource) {
			// Scanned and checked whole before any part is written, so a refused source leaves nothing
			// behind even when the caller carries on with the transaction.
			yield* refuseSecrets(input, `${tier}/sources/${input.id}`);

			const home = view.locate(input.id);

			if (home !== undefined && home.tier !== tier) {
				return yield* reject(`Source ${input.id} is in the ${home.tier} tier already`);
			}

			const existing = state.sources[input.id];
			const { passages, headings, ...core } = input;

			for (const [id, text] of Object.entries(passages)) {
				if (existing !== undefined && id in existing.passages && existing.passages[id] !== text) {
					return yield* reject(`Passage ${input.id}#^${id} already holds different text`);
				}
			}

			const stored = { ...core, agent: existing?.agent ?? agent };

			yield* checked(Source, {
				...existing,
				...stored,
				passages: { ...existing?.passages, ...passages },
				headings: { ...existing?.headings, ...headings },
			});

			yield* write(
				"sources",
				Source,
				{
					...existing,
					...stored,
					passages: existing?.passages ?? {},
				},
				"sources",
				input.id,
				stored,
			);

			for (const [id, text] of Object.entries(passages)) {
				yield* passage(yield* source(input.id), id, text, headings?.[id]);
			}

			return yield* source(input.id);
		}),
		addPassage: Effect.fnUntraced(function* (sourceId: string, text: string, heading?: string) {
			const current = yield* source(sourceId);
			const existing = Object.entries(current.passages).find(([, value]) => value === text);

			if (existing) {
				return existing[0];
			}

			const id = `p-${hash(text).slice(0, 10)}`;

			yield* passage(current, id, text, heading);

			return id;
		}),
		putTopic: Effect.fnUntraced(function* (input: Topic) {
			return yield* write("topics", Topic, input, "topics", input.id, input);
		}),
	};
}

/**
 * The backstop on every commit: whatever the operations did, every claim that existed is still
 * there, and no new claim ID is held by another tier.
 */
function lostOrDuplicated(
	tier: Tier,
	before: TierState,
	after: TierState,
	committed: Readonly<Record<Tier, TierState>>,
) {
	for (const id of Object.keys(before.claims)) {
		if (!(id in after.claims)) {
			return `Write would lose claim ${id}`;
		}
	}

	const taken = Object.keys(after.claims).find(
		(id) =>
			!(id in before.claims) &&
			tiers.some((other) => other !== tier && id in committed[other].claims),
	);

	return taken === undefined ? undefined : `Write would duplicate claim ${taken}`;
}

interface Loaded {
	readonly doc: LoroDoc;
	readonly state: TierState;
}

const makeVault = Effect.fnUntraced(function* (config: VaultConfig) {
	const files = yield* TierFiles;
	const peerName = `${config.agent}@${config.host ?? os.hostname()}`;
	// 48 bits of the name's hash: a stable peer per agent and host that fits a JS safe integer.
	const peerId = BigInt(`0x${hash(peerName).slice(0, 12)}`);

	const load = Effect.fnUntraced(function* (tier: Tier) {
		const bytes = Option.getOrUndefined(yield* files.read(tier));
		const doc =
			bytes === undefined
				? new LoroDoc()
				: yield* Effect.try({
						try: () => LoroDoc.fromSnapshot(bytes),
						catch: (cause) => new TierUnreadable({ tier, reason: String(cause) }),
					});

		return { doc, state: readState(doc) } satisfies Loaded;
	});

	const loadAll = Effect.map(
		Effect.all({ shared: load("shared"), personal: load("personal"), agent: load("agent") }),
		(loaded: Record<Tier, Loaded>) => ({
			loaded,
			states: {
				shared: loaded.shared.state,
				personal: loaded.personal.state,
				agent: loaded.agent.state,
			} satisfies Record<Tier, TierState>,
		}),
	);

	const commit = Effect.fnUntraced(function* (
		tier: Tier,
		base: Loaded,
		doc: LoroDoc,
		committed: Readonly<Record<Tier, TierState>>,
		message: string,
		seconds: number,
	) {
		doc.commit({ message, timestamp: seconds });

		// Everything this write adds to the file's history, commit message included: a value set and
		// then overwritten stays in the op log forever, so the log is what gets scanned.
		yield* refuseSecrets(
			doc.exportJsonUpdates(base.doc.oplogVersion(), doc.oplogVersion()),
			`${tier} tier`,
		);

		const problem = lostOrDuplicated(tier, base.state, readState(doc), committed);

		if (problem !== undefined) {
			return yield* reject(problem);
		}

		yield* files.save(tier, doc.export({ mode: "snapshot" }));
	});

	const transact: VaultShape["transact"] = (tier, message, body) =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* files.lock(tier);

				const { loaded, states } = yield* loadAll;
				const base = loaded[tier];
				const doc = base.doc.fork();

				doc.setPeerId(peerId);
				doc.setRecordTimestamp(true);
				// Never fold two commits into one change: each write keeps its own author, time and message.
				doc.setChangeMergeInterval(-1);

				const millis = yield* Clock.currentTimeMillis;
				const tx = makeTx(tier, doc, states, config.agent, new Date(millis).toISOString());
				const result = yield* body(tx);

				yield* commit(tier, base, doc, states, message, Math.floor(millis / 1000));

				return result;
			}),
		);

	return {
		root: config.root,
		agent: config.agent,
		file: files.file,
		view: Effect.map(loadAll, ({ states }) => makeView(states)),
		transact,
		snapshot: (tier) => Effect.map(load(tier), ({ doc }) => doc.export({ mode: "snapshot" })),
	} satisfies VaultShape;
});

export class Vault extends Context.Service<Vault, VaultShape>()("vault-engine/Vault") {
	static readonly make = makeVault;
	static readonly layer = (config: VaultConfig) =>
		Layer.effect(Vault, makeVault(config)).pipe(
			Layer.provide(TierFiles.layer(config.root, config.host)),
		);
}
