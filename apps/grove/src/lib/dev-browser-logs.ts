const SENSITIVE_KEY = /authorization|cookie|password|secret|token/i;
const MAX_SERIALIZED_VALUE = 2_000;

const redactText = (value: string) =>
	value
		.replace(/\bauthorization\s*[:=]\s*Bearer\s+[^\s,;]+/gi, "authorization=[REDACTED]")
		.replace(/\bBearer\s+[A-Za-z\d._~+/-]+=*/gi, "Bearer [REDACTED]")
		.replace(
			/\b(cookie|password|secret|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
			"$1=[REDACTED]",
		);

export const serializeDevBrowserLogValue = (value: unknown) => {
	if (typeof value === "string") return redactText(value).slice(0, MAX_SERIALIZED_VALUE);
	if (value instanceof Error)
		return redactText(`${value.name}: ${value.message}\n${value.stack ?? ""}`).slice(
			0,
			MAX_SERIALIZED_VALUE,
		);
	const seen = new WeakSet<object>();
	try {
		const serialized: unknown = JSON.stringify(value, (key: string, entry: unknown) => {
			if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
			if (entry !== null && typeof entry === "object") {
				if (seen.has(entry)) return "[Circular]";
				seen.add(entry);
			}
			return entry;
		});
		return redactText(typeof serialized === "string" ? serialized : String(value)).slice(
			0,
			MAX_SERIALIZED_VALUE,
		);
	} catch {
		return redactText(String(value)).slice(0, MAX_SERIALIZED_VALUE);
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
				timestamp: new Date().toISOString(),
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
