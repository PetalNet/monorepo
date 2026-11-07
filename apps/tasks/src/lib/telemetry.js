// Error-reporting options shared by the server and browser hooks. Events must never carry
// credentials: Authentik and proxy headers, session cookies, agent bearer tokens, share tokens
// in /s/<token> URLs, or secret-looking query parameters. scrubEvent runs on every event
// before it leaves the process, so this does not depend on Glitchtip's own scrubbing settings.

const SECRET_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-.*)$/iu;
const SECRET_PARAM = /token|key|secret|passw|auth|session|sig|code|dsn/iu;
const SHARE_PATH = /\/s\/[^/?#]+/gu;
const REDACTED = "[redacted]";

function scrubQuery(query) {
	const params = new URLSearchParams(query);

	for (const name of params.keys()) {
		if (SECRET_PARAM.test(name)) {
			params.set(name, REDACTED);
		}
	}

	return params.toString();
}

/** @param {string} url */
function scrubUrl(url) {
	const [beforeHash] = url.split("#");
	const [path = "", query] = beforeHash.split("?");
	const cleanPath = path.replaceAll(SHARE_PATH, `/s/${REDACTED}`);

	return query === undefined ? cleanPath : `${cleanPath}?${scrubQuery(query)}`;
}

/** @param {Record<string, unknown>} headers */
function scrubHeaders(headers) {
	return Object.fromEntries(Object.entries(headers).filter(([name]) => !SECRET_HEADER.test(name)));
}

/**
 * @template {{ data?: Record<string, unknown> }} B
 * @param {B} crumb
 * @returns {B}
 */
function scrubBreadcrumb(crumb) {
	if (typeof crumb.data?.url === "string") {
		crumb.data.url = scrubUrl(crumb.data.url);
	}

	return crumb;
}

/**
 * @template {{
 * 	request?: Record<string, unknown>;
 * 	breadcrumbs?: { data?: Record<string, unknown> }[];
 * }} E
 * @param {E} event
 * @returns {E}
 */
function scrubEvent(event) {
	const request = event.request;

	if (request) {
		delete request.cookies;
		delete request.data;

		if (request.headers && typeof request.headers === "object") {
			request.headers = scrubHeaders(/** @type {Record<string, unknown>} */ (request.headers));
		}

		if (typeof request.url === "string") {
			request.url = scrubUrl(request.url);
		}

		if (typeof request.query_string === "string") {
			request.query_string = scrubQuery(request.query_string);
		} else if (request.query_string !== undefined) {
			delete request.query_string;
		}
	}

	for (const crumb of event.breadcrumbs ?? []) {
		scrubBreadcrumb(crumb);
	}

	return event;
}

/** @param {{ dsn: string | undefined; environment: string | undefined }} env */
export function sentryOptions({ dsn, environment }) {
	return {
		dsn,
		enabled: Boolean(dsn),
		environment: environment || "production",
		// errors only — no perf tracing, no session replay
		tracesSampleRate: 0,
		sendDefaultPii: false,
		beforeSend: scrubEvent,
		beforeBreadcrumb: scrubBreadcrumb,
	};
}
