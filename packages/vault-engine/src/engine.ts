import { createHash, randomBytes } from "node:crypto";
import os from "node:os";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { LoroDoc } from "loro-crdt";
import type { Value } from "loro-crdt";

import { TierUnreadable, WriteRejected } from "./errors.ts";
import { Claim, Topic, tiers } from "./schema.ts";
import type { Tier } from "./schema.ts";
import { TierFiles } from "./store.ts";

/** One tier as readers see it: every record whole, keyed by its own ID. */
export interface TierState {
	readonly claims: Record<string, Claim>;
	readonly topics: Record<string, Topic>;
}

/** How a tier is laid out inside its Loro document. Every map holds plain values keyed by ID. */
interface Stored {
	claims: Record<string, Claim>;
	topics: Record<string, Topic>;
}

export type NewClaim = Pick<Claim, "text" | "topic" | "heading" | "sourceType">;

/** Every tier at one moment. */
export interface VaultView {
	readonly tiers: Readonly<Record<Tier, TierState>>;
}

/** One write on one tier. Each method stages a checked record; the transaction commits them all. */
export interface Tx extends VaultView {
	readonly tier: Tier;
	/** The write time, as an ISO string. */
	readonly now: string;
	/** This tier as staged so far. */
	readonly state: TierState;
	readonly addClaim: (input: NewClaim) => Effect.Effect<Claim, WriteRejected>;
	readonly putTopic: (input: Topic) => Effect.Effect<Topic, WriteRejected>;
}

export type VaultError = PlatformError | TierUnreadable;

export interface VaultShape {
	readonly root: string;
	/** The writing agent. Each agent on each host writes as its own Loro peer. */
	readonly agent: string;
	readonly view: Effect.Effect<VaultView, VaultError>;
	/** Runs one write under the tier's lock. It commits only if every operation passed its checks. */
	readonly transact: <A, E, R>(
		tier: Tier,
		message: string,
		body: (tx: Tx) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | WriteRejected | VaultError, R>;
}

export interface VaultConfig {
	readonly root: string;
	readonly agent: string;
	/** Names this host in the writer's peer; defaults to the hostname. */
	readonly host?: string;
}

const reject = (message: string) => new WriteRejected({ message });
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function readState(doc: LoroDoc): TierState {
	const stored = Object.fromEntries(
		["claims", "topics"].map((name) => [name, doc.getMap(name).toJSON() as unknown]),
	) as unknown as Stored;

	return { claims: stored.claims, topics: stored.topics };
}

const checked = <A>(schema: Schema.Decoder<A>, value: unknown) =>
	// Strict: a record key the schema does not know, even one a record schema would drop, is refused.
	Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
		Effect.mapError((error) => reject(error.message)),
	);

function makeView(states: Readonly<Record<Tier, TierState>>): VaultView {
	return { tiers: states };
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
		topics: { ...base.topics },
	};
	const view = makeView({ ...committed, [tier]: state });

	/**
	 * The one way a transaction writes: the record is checked against its schema, then the stored
	 * value is set in the document and the record staged for later reads in this write.
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

	const newClaimId = () => {
		for (;;) {
			const id = `c-${BigInt(`0x${randomBytes(8).toString("hex")}`)
				.toString(36)
				.padStart(8, "0")
				.slice(-8)}`;

			if (!tiers.some((each) => id in view.tiers[each].claims)) {
				return id;
			}
		}
	};

	const addClaim = Effect.fnUntraced(function* (input: NewClaim) {
		if (!(input.topic in state.topics)) {
			return yield* reject(`Topic ${input.topic} is not in the ${tier} tier`);
		}

		const core = { ...input, id: newClaimId(), created: now, agent };

		return yield* write("claims", Claim, core, "claims", core.id, core);
	});

	return {
		...view,
		tier,
		now,
		state,
		addClaim,
		putTopic: Effect.fnUntraced(function* (input: Topic) {
			return yield* write("topics", Topic, input, "topics", input.id, input);
		}),
	};
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
		doc: LoroDoc,
		message: string,
		seconds: number,
	) {
		doc.commit({ message, timestamp: seconds });

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

				yield* commit(tier, doc, message, Math.floor(millis / 1000));

				return result;
			}),
		);

	return {
		root: config.root,
		agent: config.agent,
		view: Effect.map(loadAll, ({ states }) => makeView(states)),
		transact,
	} satisfies VaultShape;
});

export class Vault extends Context.Service<Vault, VaultShape>()("vault-engine/Vault") {
	static readonly make = makeVault;
	static readonly layer = (config: VaultConfig) =>
		Layer.effect(Vault, makeVault(config)).pipe(
			Layer.provide(TierFiles.layer(config.root, config.host)),
		);
}
