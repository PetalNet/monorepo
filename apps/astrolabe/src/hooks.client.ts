import type { HandleClientError } from "@sveltejs/kit/hooks";

export const handleError: HandleClientError = async ({ kind, error, event }) => {
	if (
		kind !== "unknown" ||
		!(error instanceof TypeError) ||
		event.url.href !== window.location.href
	) {
		return;
	}

	// A data fetch that follows Authentik's redirect fails CORS. Confirm the document
	// also needs sign-in before reloading, since an offline browser also throws TypeError.
	const response = await fetch(event.url, {
		method: "HEAD",
		redirect: "manual",
		cache: "no-store",
		signal: AbortSignal.timeout(5000),
	}).catch(() => undefined);

	if (response?.type === "opaqueredirect" || response?.status === 401) {
		window.location.reload();

		return { status: 401, message: "Signing in…" };
	}
};
