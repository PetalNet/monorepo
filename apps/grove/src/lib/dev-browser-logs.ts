import { sanitizeDevBrowserLogText, sanitizeDevBrowserLogValue } from "./dev-browser-log-sanitizer";

const MAX_SERIALIZED_VALUE = 2_000;

export const serializeDevBrowserLogValue = (value: unknown) => {
	const sanitized = sanitizeDevBrowserLogValue(value);
	if (typeof sanitized === "string") return sanitized.slice(0, MAX_SERIALIZED_VALUE);
	try {
		const serialized: unknown = JSON.stringify(sanitized);
		return (typeof serialized === "string" ? serialized : String(sanitized)).slice(
			0,
			MAX_SERIALIZED_VALUE,
		);
	} catch {
		return sanitizeDevBrowserLogText(String(sanitized)).slice(0, MAX_SERIALIZED_VALUE);
	}
};

type BrowserLogLevel = "error" | "warn" | "uncaught" | "unhandled-rejection";

const submit = (level: BrowserLogLevel, source: string, values: readonly unknown[]) => {
	const body = JSON.stringify({
		entries: [
			{
				level,
				message: values.map(serializeDevBrowserLogValue).join(" ").slice(0, MAX_SERIALIZED_VALUE),
				source,
			},
		],
	});
	void fetch("/__dev/logs/browser", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		credentials: "omit",
		keepalive: true,
	}).catch(() => undefined);
};

export const installDevBrowserLogs = () => {
	const originalError = console.error;
	const originalWarn = console.warn;
	console.error = (...values: unknown[]) => {
		Reflect.apply(originalError, console, values);
		submit("error", "console.error", values);
	};
	console.warn = (...values: unknown[]) => {
		Reflect.apply(originalWarn, console, values);
		submit("warn", "console.warn", values);
	};
	const onError = (event: ErrorEvent) => {
		const error: unknown = event.error;
		submit("uncaught", "window.error", [error ?? event.message]);
	};
	const onUnhandledRejection = (event: PromiseRejectionEvent) => {
		const reason: unknown = event.reason;
		submit("unhandled-rejection", "window.unhandledrejection", [reason]);
	};
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onUnhandledRejection);
	return () => {
		console.error = originalError;
		console.warn = originalWarn;
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onUnhandledRejection);
	};
};
