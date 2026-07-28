interface OptimisticCounterOptions<Collection> {
	readonly withOverride: (update: (current: Collection) => Collection) => () => void;
	readonly update: (current: Collection, key: string, value: number) => Collection;
	readonly onError: (error: unknown) => void;
	readonly onStart?: () => void;
	readonly failureMessage: string;
}

export class OptimisticCounter<Collection> {
	readonly #options: OptimisticCounterOptions<Collection>;
	readonly #values = $state<Record<string, number>>({});
	readonly #releases = new Map<string, () => void>();
	readonly #barriers = new Map<string, Promise<void>>();
	readonly #followups = new Map<string, Promise<unknown>>();

	constructor(options: OptimisticCounterOptions<Collection>) {
		this.#options = options;
	}

	value(key: string, current: number) {
		return this.#values[key] ?? current;
	}

	increment(key: string, current: number) {
		this.#options.onStart?.();
		this.#values[key] = this.value(key, current) + 1;
		if (!this.#releases.has(key)) {
			this.#releases.set(
				key,
				this.#options.withOverride((collection) =>
					this.#options.update(collection, key, this.#values[key]!),
				),
			);
		}
	}

	async submit(key: string, submit: () => Promise<boolean>) {
		const previous = this.#barriers.get(key) ?? Promise.resolve();
		const task = (async () => {
			await previous;
			try {
				if (!(await submit())) {
					this.#rollback(key);
					this.#options.onError(new Error(this.#options.failureMessage));
				}
			} catch (error) {
				this.#rollback(key);
				this.#options.onError(error);
			}
		})();
		const barrier = task.then(() => undefined);
		this.#barriers.set(key, barrier);
		void barrier.then(() => {
			if (this.#barriers.get(key) === barrier) this.#release(key);
			return undefined;
		});
		await task;
	}

	after<T>(key: string, action: () => Promise<T>): Promise<T> {
		const pending = this.#followups.get(key);
		if (pending) return pending as Promise<T>;

		const task = this.#wait(key).then(action);
		this.#followups.set(key, task);
		const cleanup = () => {
			if (this.#followups.get(key) === task) this.#followups.delete(key);
			return undefined;
		};
		void task.then(cleanup, cleanup);
		return task;
	}

	#rollback(key: string) {
		const value = this.#values[key];
		if (value !== undefined) this.#values[key] = value - 1;
	}

	#release(key: string) {
		this.#barriers.delete(key);
		this.#releases.get(key)?.();
		this.#releases.delete(key);
		delete this.#values[key];
	}

	async #wait(key: string): Promise<void> {
		const barrier = this.#barriers.get(key);
		if (!barrier) return;
		await barrier;
		return this.#wait(key);
	}
}
