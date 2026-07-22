import { register } from "node:module";

import { glitchtipDsnSchema } from "$lib/env-schemas";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { NodeSDK } from "@opentelemetry/sdk-node";
import * as Sentry from "@sentry/sveltekit";
import { createAddHookMessageChannel } from "import-in-the-middle";
import { Schema } from "effect";

const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (otelEndpoint) {
	// Register the import-in-the-middle ESM loader hook before starting the SDK so the
	// auto-instrumentations can patch ES modules (pg, http, ...). Under ESM,
	// @opentelemetry/instrumentation cannot intercept imports without this hook. adapter-node loads
	// this instrumentation module before the app graph, so the hook is active before any
	// instrumented module is imported. import-in-the-middle is pinned to 2.x to match
	// @opentelemetry/instrumentation's own copy; a mismatched major shares no hook registry and
	// would silently instrument nothing.
	const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
	// eslint-disable-next-line @typescript-eslint/no-deprecated -- import-in-the-middle 2.0.6 requires module.register(); registerHooks() is an incompatible synchronous API and IITM ships no alternative.
	register("import-in-the-middle/hook.mjs", import.meta.url, registerOptions);
	await waitForAllMessagesAcknowledged();

	const sdk = new NodeSDK({
		traceExporter: new OTLPTraceExporter({ url: `${otelEndpoint.replace(/\/$/, "")}/v1/traces` }),
		instrumentations: [getNodeAutoInstrumentations()],
	});
	sdk.start();
}

// This bootstrap runs before the app runtime (and its ConfigProvider) exists, so it applies the
// shared DSN schema directly rather than reading process.env raw — the seam is validated here too.
const glitchtipDsn = Schema.decodeUnknownSync(glitchtipDsnSchema)(process.env.PUBLIC_GLITCHTIP_DSN);

if (glitchtipDsn) {
	Sentry.init({
		dsn: glitchtipDsn,
		tracesSampleRate: 0,
		sendDefaultPii: false,
	});
}
