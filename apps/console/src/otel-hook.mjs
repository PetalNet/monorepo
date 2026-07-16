// Registers the import-in-the-middle loader hook so the auto-instrumentations started by
// instrumentation.server.ts (NodeSDK) can patch ES modules (pg, http, ...). Under ESM,
// @opentelemetry/instrumentation cannot intercept imports without this hook. instrumentation.server.ts
// awaits this before starting the SDK, and adapter-node loads that module before the app graph, so
// the hook is active before any instrumented module (pg/http/...) is imported.
//
// import-in-the-middle is pinned to 2.x to match @opentelemetry/instrumentation's own copy; a
// mismatched major shares no hook registry and would silently instrument nothing.
import { register } from "node:module";
import process from "node:process";

import { createAddHookMessageChannel } from "import-in-the-middle";

export async function registerOtelHook() {
	if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
	const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
	register("import-in-the-middle/hook.mjs", import.meta.url, registerOptions);
	await waitForAllMessagesAcknowledged();
}
