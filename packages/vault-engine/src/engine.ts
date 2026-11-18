import { createHash, randomBytes } from "node:crypto";
import os from "node:os";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { LoroDoc } from "loro-crdt";
import type { Value } from "loro-crdt";

import { SecretFound, TierUnreadable, WriteRejected } from "./errors.ts";
import { Claim, Run, Source, Topic, tiers } from "./schema.ts";
import type { Link, Tier } from "./schema.ts";
import { secretRules } from "./secrets.ts";
import { TierFiles, stampOf } from "./store.ts";

/** One tier as readers see it: every record whole, keyed by its own ID. */
export interface TierState {
	readonly claims: Record<string, Claim>;
	readonly sources: Record<string, Source>;
	readonly topics: Record<string, Topic>;
	readonly runs: Record<string, Run>;
}

/**
 * How a tier is laid out inside its Loro document. Every map holds plain values keyed by ID. A Loro
 * map keeps one writer's value per key, so anything two replicas may write at the same time has its
 * own key: a claim's text never shares a key with its retirement or its stale flag, and each
 * passage is its own entry, addressed by a hash of its text.
 */
interface Stored {
	claims: Record<string, Omit<Claim, "status" | "supersededBy" | "reason" | "stale" | "updated">>;
	retired: Record<string, Retirement>;
	stale: Record<string, NonNullable<Claim["stale"]>>;
	sources: Record<
		string,
		Omit<Source, "status" | "replacedBy" | "reason" | "passages" | "headings">
	>;
	sourceStatus: Record<string, SourceRetirement>;
	passages: Record<string, { text: string; heading?: string }>;
	topics: Record<string, Topic>;
	runs: Record<string, Run>;
}

interface Retirement {
	readonly status: "superseded" | "retracted";
	readonly supersededBy?: string;
	readonly reason?: string;
	readonly at: string;
}

export type SourceRetirement =
	| { readonly status: "replaced"; readonly replacedBy: string; readonly reason: string }
	| { readonly status: "retracted"; readonly reason: string };

export type NewClaim = Pick<Claim, "text" | "topic" | "heading" | "links" | "sourceType"> &
	Partial<Pick<Claim, "verdict" | "run">>;

export type NewSource = Omit<Source, "agent" | "status" | "replacedBy" | "reason">;

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
	/** Claims are never edited: the old claim stays, marked superseded, and the new one links back. */
	readonly replaceClaim: (
		id: string,
		input: NewClaim,
	) => Effect.Effect<Claim, WriteRejected | SecretFound>;
	readonly retractClaim: (
		id: string,
		reason: string,
	) => Effect.Effect<Claim, WriteRejected | SecretFound>;
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
	readonly setSourceStatus: (
		id: string,
		change: SourceRetirement,
	) => Effect.Effect<Source, WriteRejected | SecretFound>;
	/** Flags every active claim in this tier that cites a retired source; returns the new flags. */
	readonly flagDependents: Effect.Effect<string[], WriteRejected | SecretFound>;
	readonly putTopic: (input: Topic) => Effect.Effect<Topic, WriteRejected | SecretFound>;
	readonly putRun: (
		input: Omit<Run, "agent" | "date"> & Partial<Pick<Run, "date">>,
	) => Effect.Effect<Run, WriteRejected | SecretFound>;
}

export type VaultError = PlatformError | TierUnreadable;

export interface VaultShape {
	readonly root: string;
	/** The writing agent. Each agent on each host writes as its own Loro peer. */
	readonly agent: string;
	/** An Obsidian folder kept current after each write, if any. */
	readonly projection: string | undefined;
	readonly file: (tier: Tier) => string;
	readonly view: Effect.Effect<VaultView, VaultError>;
	/**
	 * Runs one write under the tier's lock. It commits only if every operation passed its checks, no
	 * claim was lost or rewritten, and the tier file is still the version the write started from.
	 */
	readonly transact: <A, E, R>(
		tier: Tier,
		message: string,
		body: (tx: Tx) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | WriteRejected | SecretFound | VaultError, R>;
	/** Marks a source replaced or retracted and flags every claim, in any tier, that cites it. */
	readonly retireSource: (
		id: string,
		change: SourceRetirement,
	) => Effect.Effect<string[], WriteRejected | SecretFound | VaultError>;
	/** Flags, in every tier, the active claims that cite a retired source. */
	readonly reconcile: (
		reason: string,
	) => Effect.Effect<string[], WriteRejected | SecretFound | VaultError>;
	readonly snapshot: (tier: Tier) => Effect.Effect<Uint8Array, VaultError>;
}

export interface VaultConfig {
	readonly root: string;
	readonly agent: string;
	/** Names this host in the writer's peer; defaults to the hostname. */
	readonly host?: string;
	readonly projection?: string;
}

const reject = (message: string) => new WriteRejected({ message });
const passageKey = (source: string, passage: string) => `${source}#${passage}`;
const isClaimId = (id: string) => id.startsWith("c-");
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function readState(doc: LoroDoc): TierState {
	const stored = Object.fromEntries(
		["claims", "retired", "stale", "sources", "sourceStatus", "passages", "topics", "runs"].map(
			(name) => [name, doc.getMap(name).toJSON() as unknown],
		),
	) as unknown as Stored;
	const sources: Record<string, Source> = {};

	for (const [id, core] of Object.entries(stored.sources)) {
		sources[id] = { ...core, status: "active", ...stored.sourceStatus[id], passages: {} };
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

	const claims: Record<string, Claim> = {};

	for (const [id, core] of Object.entries(stored.claims)) {
		const { at, ...retired } = stored.retired[id] ?? { at: undefined };
		const stale = stored.stale[id];

		claims[id] = {
			...core,
			status: "active",
			...retired,
			...(stale === undefined ? {} : { stale }),
			updated: at ?? stale?.since ?? core.created,
		};
	}

	return { claims, sources, topics: stored.topics, runs: stored.runs };
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

/** The sources a claim cites that have been replaced or retracted, in ID order. */
const retiredSources = (view: VaultView, claim: Claim) =>
	[
		...new Set(
			claim.links
				.filter((link) => {
					const source = view.source(link.target);

					return source !== undefined && source.status !== "active";
				})
				.map((link) => link.target),
		),
	].toSorted();

/** The part of a claim that never changes after it is written. */
const fixed = ({
	status: _s,
	supersededBy: _b,
	reason: _r,
	stale: _f,
	updated: _u,
	...rest
}: Claim) => JSON.stringify(Object.entries(rest).toSorted(([a], [b]) => a.localeCompare(b)));

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
		runs: { ...base.runs },
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

	const claim = (id: string) => {
		const found = state.claims[id];

		return found
			? Effect.succeed(found)
			: Effect.fail(reject(`Claim ${id} is not in the ${tier} tier`));
	};

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

			if (link.rel === "replaces" && found.kind !== "claims") {
				return yield* reject("replaces:: must point at a claim");
			}

			if (
				link.passage !== undefined &&
				!(link.passage in (view.source(link.target)?.passages ?? {}))
			) {
				return yield* reject(`Passage ${link.target}#^${link.passage} does not exist`);
			}
		}
	});

	const retire = Effect.fnUntraced(function* (id: string, change: Retirement) {
		const { at, ...fields } = change;

		yield* write(
			"claims",
			Claim,
			{ ...(yield* claim(id)), ...fields, updated: at },
			"retired",
			id,
			change,
		);
	});

	const flag = Effect.fnUntraced(function* (current: Claim, sources: readonly string[]) {
		const stale = { since: current.stale?.since ?? now, sources };

		yield* write("claims", Claim, { ...current, stale, updated: now }, "stale", current.id, stale);
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
		const added = yield* write(
			"claims",
			Claim,
			{ ...core, status: "active", updated: now },
			"claims",
			core.id,
			core,
		);

		for (const link of input.links) {
			if (link.rel === "replaces") {
				yield* retire(link.target, { status: "superseded", supersededBy: added.id, at: now });
			}
		}

		const retired = retiredSources(view, added);

		if (retired.length > 0) {
			yield* flag(added, retired);
		}

		return yield* claim(added.id);
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
		replaceClaim: (id, input) =>
			claim(id).pipe(
				Effect.andThen(
					addClaim({
						...input,
						links: [
							...input.links.filter((link) => !(link.rel === "replaces" && link.target === id)),
							{ rel: "replaces", target: id },
						],
					}),
				),
			),
		retractClaim: (id, reason) =>
			retire(id, { status: "retracted", reason, at: now }).pipe(Effect.andThen(claim(id))),
		putSource: Effect.fnUntraced(function* (input: NewSource) {
			// Scanned and checked whole before any part is written, so a refused source leaves nothing
			// behind even when the caller carries on with the transaction, as migration does.
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
				status: existing?.status ?? "active",
				passages: { ...existing?.passages, ...passages },
				headings: { ...existing?.headings, ...headings },
			});

			yield* write(
				"sources",
				Source,
				{
					...existing,
					...stored,
					status: existing?.status ?? "active",
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
		setSourceStatus: Effect.fnUntraced(function* (id: string, change: SourceRetirement) {
			yield* write(
				"sources",
				Source,
				{ ...(yield* source(id)), ...change },
				"sourceStatus",
				id,
				change,
			);

			return yield* source(id);
		}),
		flagDependents: Effect.gen(function* () {
			const flagged: string[] = [];

			for (const current of Object.values(state.claims)) {
				const retired = retiredSources(view, current);
				const known = current.stale?.sources ?? [];

				if (current.status === "active" && retired.some((id) => !known.includes(id))) {
					yield* flag(current, [...new Set([...known, ...retired])].toSorted());
					flagged.push(current.id);
				}
			}

			return flagged;
		}),
		putTopic: Effect.fnUntraced(function* (input: Topic) {
			return yield* write("topics", Topic, input, "topics", input.id, input);
		}),
		putRun: Effect.fnUntraced(function* (
			input: Omit<Run, "agent" | "date"> & Partial<Pick<Run, "date">>,
		) {
			const run = { date: now, ...input, agent };

			return yield* write("runs", Run, run, "runs", run.id, run);
		}),
	};
}

/**
 * The backstop on every commit: whatever the operations did, every claim that existed is still
 * there with the same core, none came back to life, and no new claim ID is held by another tier.
 */
function lostOrDuplicated(
	tier: Tier,
	before: TierState,
	after: TierState,
	committed: Readonly<Record<Tier, TierState>>,
) {
	for (const [id, old] of Object.entries(before.claims)) {
		const now = after.claims[id];

		if (!now) {
			return `Write would lose claim ${id}`;
		}

		if (fixed(now) !== fixed(old)) {
			return `Write would rewrite claim ${id}; replace it instead`;
		}

		if (old.status !== "active" && now.status === "active") {
			return `Write would revive ${old.status} claim ${id}`;
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
	/** A hash of the file's bytes, or "new" when the tier has no file yet. */
	readonly stamp: string;
	readonly doc: LoroDoc;
	readonly state: TierState;
}

const makeVault = Effect.fnUntraced(function* (config: VaultConfig) {
	const files = yield* TierFiles;
	const peerName = `${config.agent}@${config.host ?? os.hostname()}`;
	// 48 bits of the name's hash: a stable peer per agent and host that fits a JS safe integer.
	const peerId = BigInt(`0x${hash(peerName).slice(0, 12)}`);
	const cache = new Map<Tier, Loaded>();

	/** The bytes are read once and stamped, so what was loaded is what was stamped. */
	const load = Effect.fnUntraced(function* (tier: Tier) {
		const read = yield* files.read(tier);
		const stamp = stampOf(read);
		const bytes = Option.getOrUndefined(read);
		const cached = cache.get(tier);

		if (cached?.stamp === stamp) {
			return cached;
		}

		const doc =
			bytes === undefined
				? new LoroDoc()
				: yield* Effect.try({
						try: () => LoroDoc.fromSnapshot(bytes),
						catch: (cause) => new TierUnreadable({ tier, reason: String(cause) }),
					});
		const loaded = { stamp, doc, state: readState(doc) };

		cache.set(tier, loaded);

		return loaded;
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
		const labelled = doc.getMap("meta").get("tier");

		if (labelled === undefined) {
			doc.getMap("meta").set("tier", tier);
		} else if (labelled !== tier) {
			return yield* reject(`The file for the ${tier} tier holds another tier's document`);
		}

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

		yield* files.save(tier, base.stamp, doc.export({ mode: "snapshot" }));
		cache.delete(tier);
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

	const reconcile = Effect.fnUntraced(function* (reason: string) {
		const flagged: string[] = [];

		for (const tier of tiers) {
			const view = makeView((yield* loadAll).states);
			const pending = Object.values(view.tiers[tier].claims).some(
				(claim) =>
					claim.status === "active" &&
					retiredSources(view, claim).some((id) => claim.stale?.sources.includes(id) !== true),
			);

			if (pending) {
				flagged.push(...(yield* transact(tier, reason, (tx) => tx.flagDependents)));
			}
		}

		return flagged;
	});

	return {
		root: config.root,
		agent: config.agent,
		projection: config.projection,
		file: files.file,
		view: Effect.map(loadAll, ({ states }) => makeView(states)),
		transact,
		reconcile,
		retireSource: Effect.fnUntraced(function* (id: string, change: SourceRetirement) {
			const view = makeView((yield* loadAll).states);
			const found = view.locate(id);

			if (found?.kind !== "sources") {
				return yield* reject(`Source ${id} is not in the vault`);
			}

			if (change.status === "replaced" && !view.source(change.replacedBy)) {
				return yield* reject(`Replacement source ${change.replacedBy} is not in the vault`);
			}

			const here = yield* transact(found.tier, `${change.status} source ${id}`, (tx) =>
				tx.setSourceStatus(id, change).pipe(Effect.andThen(tx.flagDependents)),
			);

			// A crash here leaves other tiers unflagged; the next retire or reconcile finishes the job.
			return [...here, ...(yield* reconcile(`${change.status} source ${id}`))];
		}),
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
