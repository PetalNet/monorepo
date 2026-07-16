import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { NodeSDK } from "@opentelemetry/sdk-node";
import * as Sentry from "@sentry/sveltekit";

const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (otelEndpoint) {
	const sdk = new NodeSDK({
		traceExporter: new OTLPTraceExporter({ url: `${otelEndpoint.replace(/\/$/, "")}/v1/traces` }),
		instrumentations: [getNodeAutoInstrumentations()],
	});
	sdk.start();
}

if (process.env.PUBLIC_GLITCHTIP_DSN) {
	Sentry.init({
		dsn: process.env.PUBLIC_GLITCHTIP_DSN,
		tracesSampleRate: 0,
		sendDefaultPii: false,
	});
}
