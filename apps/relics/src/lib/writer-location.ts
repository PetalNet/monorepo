const key = "relics-writer-location";

export function readWriterLocation() {
	try {
		const value = localStorage.getItem(key);

		if (!value) {
			return null;
		}

		const url = new URL(value, window.location.origin);

		return url.origin === window.location.origin && url.pathname === "/admin/nfc-writer"
			? url
			: null;
	} catch {
		return null;
	}
}

export function rememberWriterLocation(url: URL) {
	try {
		localStorage.setItem(key, url.pathname + url.search);
	} catch {
		// Private browsing can disable storage; the current URL still retains this batch.
	}
}
