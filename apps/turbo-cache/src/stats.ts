import { readFile, rename, writeFile } from "node:fs/promises";

import { Schema } from "effect";

const hour = 3_600_000;
const windowHours = 24;

const Bucket = Schema.Struct({ hit: Schema.Finite, miss: Schema.Finite });
const Saved = Schema.Struct({
	since: Schema.Finite,
	buckets: Schema.Record(Schema.String, Bucket),
});

export interface Hour {
	readonly start: number;
	readonly hit: number;
	readonly miss: number;
}

export interface CacheEvents {
	readonly since: number;
	readonly hours: readonly Hour[];
	readonly hit: number;
	readonly miss: number;
}

// Turbo reports one event per task it looked up remotely: { source, event: HIT | MISS }.
const isEvent = Schema.is(Schema.Struct({ source: Schema.String, event: Schema.String }));

export function parseEvents(body: string): { hit: number; miss: number } {
	const counts = { hit: 0, miss: 0 };
	let parsed: unknown;

	try {
		parsed = JSON.parse(body);
	} catch {
		return counts;
	}

	if (!Array.isArray(parsed)) {
		return counts;
	}

	for (const item of parsed.slice(0, 1000) as unknown[]) {
		if (!isEvent(item) || item.source !== "REMOTE") {
			continue;
		}

		if (item.event === "HIT") {
			counts.hit += 1;
		} else if (item.event === "MISS") {
			counts.miss += 1;
		}
	}

	return counts;
}

export function createEventCounter(now: () => number = Date.now, saved?: typeof Saved.Type) {
	const since = saved?.since ?? now();
	const buckets = new Map<number, { hit: number; miss: number }>(
		Object.entries(saved?.buckets ?? {}).map(([start, bucket]) => [Number(start), { ...bucket }]),
	);
	let dirty = false;

	const prune = () => {
		const oldest = Math.floor(now() / hour) * hour - (windowHours - 1) * hour;

		for (const start of buckets.keys()) {
			if (start < oldest) {
				buckets.delete(start);
			}
		}
	};

	return {
		record(counts: { hit: number; miss: number }) {
			if (counts.hit + counts.miss === 0) {
				return;
			}

			const start = Math.floor(now() / hour) * hour;
			const bucket = buckets.get(start) ?? { hit: 0, miss: 0 };

			bucket.hit += counts.hit;
			bucket.miss += counts.miss;
			buckets.set(start, bucket);
			dirty = true;
		},
		snapshot(): CacheEvents {
			prune();

			const current = Math.floor(now() / hour) * hour;
			const hours = Array.from({ length: windowHours }, (_, index) => {
				const start = current - (windowHours - 1 - index) * hour;

				return { start, ...(buckets.get(start) ?? { hit: 0, miss: 0 }) };
			});

			return {
				since,
				hours,
				hit: hours.reduce((sum, item) => sum + item.hit, 0),
				miss: hours.reduce((sum, item) => sum + item.miss, 0),
			};
		},
		/** The state to persist, or null when nothing changed since the last `markSaved`. */
		pending(): typeof Saved.Type | null {
			if (!dirty) {
				return null;
			}

			prune();

			return { since, buckets: Object.fromEntries(buckets) };
		},
		markSaved() {
			dirty = false;
		},
	};
}

export async function loadEvents(file: string) {
	try {
		return Schema.decodeUnknownSync(Saved)(JSON.parse(await readFile(file, "utf8")));
	} catch {
		return undefined;
	}
}

export async function saveEvents(file: string, saved: typeof Saved.Type) {
	await writeFile(`${file}.tmp`, JSON.stringify(saved));
	await rename(`${file}.tmp`, file);
}

const Storage = Schema.Struct({
	updated: Schema.Finite,
	files: Schema.Finite,
	bytes: Schema.Finite,
	max_bytes: Schema.Finite,
	evicted_files: Schema.Finite,
	evicted_bytes: Schema.Finite,
	last_eviction: Schema.NullOr(Schema.Finite),
});

export type Storage = typeof Storage.Type;

export async function readStorage(file: string): Promise<Storage | null> {
	try {
		return Schema.decodeUnknownSync(Storage)(JSON.parse(await readFile(file, "utf8")));
	} catch {
		return null;
	}
}
