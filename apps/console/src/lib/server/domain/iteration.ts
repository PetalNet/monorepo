/** Iteration sources for loops whose bodies intentionally await ordered work. */
export function* indefinitely(): Generator<number> {
	for (let iteration = 0; ; iteration += 1) yield iteration;
}

export function* whileCondition(condition: () => boolean): Generator<number> {
	for (let iteration = 0; condition(); iteration += 1) yield iteration;
}

export function* doWhileCondition(condition: () => boolean): Generator<number> {
	let iteration = 0;
	do yield iteration++;
	while (condition());
}

/** Adapt ordered synchronous work items for a sequential async loop without hiding its intent. */
export async function* asynchronously<T>(items: Iterable<T>): AsyncGenerator<T> {
	await Promise.resolve();
	yield* items;
}
