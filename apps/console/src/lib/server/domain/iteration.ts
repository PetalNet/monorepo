/** Iteration sources for loops whose bodies intentionally await ordered work. */
export function* indefinitely(): Generator<void> {
	for (;;) yield undefined;
}

export function* whileCondition(condition: () => boolean): Generator<void> {
	while (condition()) yield undefined;
}

export function* doWhileCondition(condition: () => boolean): Generator<void> {
	do yield undefined;
	while (condition());
}
