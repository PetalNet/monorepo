/**
 * Undo history over whole document snapshots. Documents are small and immutable, so a snapshot
 * stack is simpler and safer than inverse commands.
 */
export interface History<T> {
	readonly past: readonly T[];
	readonly present: T;
	readonly future: readonly T[];
	/** Commits that share a key within the window merge into one undo step (a drag, typing). */
	readonly lastKey: string | null;
	readonly lastAt: number;
}

const LIMIT = 200;
const MERGE_WINDOW_MS = 1000;

export function startHistory<T>(present: T): History<T> {
	return { past: [], present, future: [], lastKey: null, lastAt: 0 };
}

export function commit<T>(
	history: History<T>,
	next: T,
	key: string | null = null,
	now = Date.now(),
): History<T> {
	if (next === history.present) {
		return history;
	}

	const merge = key !== null && key === history.lastKey && now - history.lastAt < MERGE_WINDOW_MS;
	const past = merge ? history.past : [...history.past, history.present].slice(-LIMIT);

	return { past, present: next, future: [], lastKey: key, lastAt: now };
}

export function undo<T>(history: History<T>): History<T> {
	const previous = history.past.at(-1);

	if (previous === undefined) {
		return history;
	}

	return {
		past: history.past.slice(0, -1),
		present: previous,
		future: [history.present, ...history.future],
		lastKey: null,
		lastAt: 0,
	};
}

export function redo<T>(history: History<T>): History<T> {
	const [next, ...future] = history.future;

	if (next === undefined) {
		return history;
	}

	return {
		past: [...history.past, history.present],
		present: next,
		future,
		lastKey: null,
		lastAt: 0,
	};
}
