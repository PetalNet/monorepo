import { settings } from "./settings.ts";

declare const chrome: {
	runtime: {
		onMessage: {
			addListener: (listener: (message: unknown) => Promise<string | null> | undefined) => void;
		};
	};
};

chrome.runtime.onMessage.addListener((message: unknown) => {
	if (
		typeof message !== "object" ||
		message === null ||
		!("type" in message) ||
		message.type !== "plantuml-server-render" ||
		!("source" in message) ||
		typeof message.source !== "string"
	) {
		return;
	}

	const source = message.source;

	return settings().then(async ({ server }) => {
		if (server === undefined) {
			return null;
		}

		const response = await fetch(`${server}/svg`, {
			method: "POST",
			headers: { "content-type": "text/plain;charset=utf-8" },
			body: source,
		});

		if (!response.ok) {
			throw new Error(`PlantUML server returned ${String(response.status)}`);
		}

		return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await response.text())}`;
	});
});
