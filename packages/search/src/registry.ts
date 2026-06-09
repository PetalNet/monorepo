// The provider registry: a tiny ordered, id-keyed collection of providers.
//
// Kept deliberately minimal — it's just bookkeeping. The federation core can
// also be handed an ad-hoc array of providers directly (see `federate.ts`), so
// the registry is a convenience for hosts that want a long-lived set.

import type { Provider } from "./types.ts";

/** A mutable, ordered set of providers keyed by `provider.id`. */
export class ProviderRegistry {
	// Map preserves insertion order, which we use as a stable tiebreak in ranking.
	readonly #providers = new Map<string, Provider>();

	/**
	 * Register a provider. Throws on duplicate id — silent overwrite would be a footgun (two sources
	 * fighting over "web"). Use {@link replace} to swap.
	 */
	register(provider: Provider): this {
		if (this.#providers.has(provider.id)) {
			throw new Error(`Provider already registered: ${provider.id}`);
		}
		this.#providers.set(provider.id, provider);
		return this;
	}

	/** Register or overwrite a provider by id. */
	replace(provider: Provider): this {
		this.#providers.set(provider.id, provider);
		return this;
	}

	/** Remove a provider by id; returns whether one was present. */
	unregister(id: string): boolean {
		return this.#providers.delete(id);
	}

	/** Look up a provider by id. */
	get(id: string): Provider | undefined {
		return this.#providers.get(id);
	}

	/** Whether a provider with this id is registered. */
	has(id: string): boolean {
		return this.#providers.has(id);
	}

	/** All providers, in registration order. */
	list(): readonly Provider[] {
		return [...this.#providers.values()];
	}

	/** Number of registered providers. */
	get size(): number {
		return this.#providers.size;
	}
}
