import { PUBLIC_CONSOLE_API_BASE, PUBLIC_CONSOLE_DATA_MODE, PUBLIC_GLITCHTIP_DSN } from "$app/env/public";
import { Config, ConfigProvider, Effect, Option } from "effect";

/** Data plane: "mock" serves in-memory fixtures; "live" reads the real substrate. */
export type DataMode = "mock" | "live";

/**
 * The one module that touches SvelteKit's env seam ($app/env/public). Everything else reads through
 * Effect's Config against this provider — so if the app moves off SvelteKit, or svelte-effect-runtime
 * ships native env support, only this provider is swapped, never the call sites.
 */
const publicEnvProvider = ConfigProvider.fromUnknown(
	Object.fromEntries(
		Object.entries({
			PUBLIC_CONSOLE_DATA_MODE,
			PUBLIC_CONSOLE_API_BASE,
			PUBLIC_GLITCHTIP_DSN,
		}).filter((entry): entry is [string, string] => entry[1] != null),
	),
);

/** Bind Effect's Config system to the public env seam. Provided to both app runtimes. */
export const PublicEnvConfigLayer = ConfigProvider.layer(publicEnvProvider);

/** `mock` when the data plane is fixtures, otherwise `live`. */
const dataModeConfig: Config.Config<DataMode> = Config.string("PUBLIC_CONSOLE_DATA_MODE").pipe(
	Config.withDefault("live"),
	Config.map((mode): DataMode => (mode === "mock" ? "mock" : "live")),
);

/** Optional override for the console REST base URL (defaults to request origin + /api/v1). */
const consoleApiBaseConfig: Config.Config<string | undefined> = Config.string(
	"PUBLIC_CONSOLE_API_BASE",
).pipe(Config.option, Config.map(Option.getOrUndefined));

/** Optional GlitchTip/Sentry DSN; error reporting is disabled when unset. */
const glitchtipDsnConfig: Config.Config<string | undefined> = Config.string(
	"PUBLIC_GLITCHTIP_DSN",
).pipe(Config.option, Config.map(Option.getOrUndefined));

/** Resolved public configuration. */
export interface PublicConfig {
	readonly dataMode: DataMode;
	readonly consoleApiBase: string | undefined;
	readonly glitchtipDsn: string | undefined;
}

/**
 * Yields the resolved public config from the ambient provider. Effect-context call sites read the
 * env exclusively through this (`const cfg = yield* readConfig`). A `ConfigError` here means the
 * env seam itself is broken, so it is promoted to a defect rather than a recoverable failure.
 */
export const readConfig: Effect.Effect<PublicConfig> = Effect.all({
	dataMode: dataModeConfig,
	consoleApiBase: consoleApiBaseConfig,
	glitchtipDsn: glitchtipDsnConfig,
}).pipe(Effect.orDie);

/**
 * Synchronously-resolved public config for the handful of call sites that run outside an Effect
 * (Svelte component scripts, the Sentry bootstrap). Still parsed through Effect Config and the same
 * provider, so those sites are decoupled from SvelteKit exactly like the effectful ones.
 */
export const publicConfig: PublicConfig = Effect.runSync(
	Effect.provide(readConfig, PublicEnvConfigLayer),
);
