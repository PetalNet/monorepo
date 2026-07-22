import { PUBLIC_CONSOLE_API_BASE, PUBLIC_CONSOLE_DATA_MODE, PUBLIC_GLITCHTIP_DSN } from "$app/env/public";
import {
	consoleApiBaseSchema,
	dataModeSchema,
	glitchtipDsnSchema,
	type DataMode,
} from "$lib/env-schemas";
import { Config, ConfigProvider, Effect } from "effect";

/**
 * The one module that touches SvelteKit's env seam ($app/env/public). Every other read goes through
 * Effect's Config against this provider — so if the app moves off SvelteKit, or svelte-effect-runtime
 * ships native env support, only this provider is swapped, never the call sites. The Config values
 * are derived from the shared Effect Schemas ($lib/env-schemas), the same definitions SvelteKit and
 * the instrumentation use, so validation and defaults live in exactly one place.
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

const dataModeConfig = Config.schema(dataModeSchema, "PUBLIC_CONSOLE_DATA_MODE");
const consoleApiBaseConfig = Config.schema(consoleApiBaseSchema, "PUBLIC_CONSOLE_API_BASE");
const glitchtipDsnConfig = Config.schema(glitchtipDsnSchema, "PUBLIC_GLITCHTIP_DSN");

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
