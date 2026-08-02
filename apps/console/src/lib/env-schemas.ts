import { Effect, Schema } from "effect";

/**
 * The single source of truth for each public environment variable. One Effect Schema per var,
 * consumed in three places: `src/env.ts` declares it to SvelteKit via `Schema.toStandardSchemaV1`,
 * `$lib/config` builds the Effect `Config` from it via `Config.schema`, and the pre-runtime
 * instrumentation parses `process.env` through it directly with `Schema.decodeUnknownSync`.
 */

/** Data plane: "mock" serves in-memory fixtures; absent decodes to the live substrate. */
export const dataModeSchema = Schema.Literals(["mock", "live"]).pipe(
	Schema.withDecodingDefault(Effect.succeed("live")),
);
export type DataMode = Schema.Schema.Type<typeof dataModeSchema>;

/** Optional override for the console REST base URL (defaults to request origin + /api/v1). */
export const consoleApiBaseSchema = Schema.UndefinedOr(Schema.String);

/** Optional GlitchTip/Sentry DSN; error reporting is disabled when unset. */
export const glitchtipDsnSchema = Schema.UndefinedOr(Schema.String);
