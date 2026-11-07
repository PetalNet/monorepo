import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import { settings } from "../src/settings.ts";

async function serverRender(source: string): Promise<string | null> {
	const { server } = await settings();

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
}

export default defineBackground(() => {
	browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
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

		// A null reply makes the renderer fall back to local rendering, as for a failed server.
		void serverRender(message.source)
			.catch(() => null)
			.then(sendResponse);

		// Keep the channel open until sendResponse runs.
		return true;
	});
});
