import { browser } from "@wxt-dev/browser";

export interface Settings {
	server?: string;
}

let savedSettings: Promise<Settings> | undefined;

export function settings(): Promise<Settings> {
	return (savedSettings ??= browser.storage.sync.get<Settings>(["server"]));
}

browser.storage.onChanged.addListener(() => {
	savedSettings = undefined;
});

function normalizeServer(value: string): string {
	const url = new URL(value);

	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("PlantUML server must use HTTP or HTTPS.");
	}

	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/u, "");

	return url.href.replace(/\/$/u, "");
}

function permissionFor(server: string): string {
	return `${new URL(server).origin}/*`;
}

export async function saveServer(value: string): Promise<boolean> {
	const previous = await settings();

	if (value.trim() === "") {
		await browser.storage.sync.remove(["server"]);

		if (previous.server !== undefined) {
			await browser.permissions.remove({ origins: [permissionFor(previous.server)] });
		}

		return true;
	}

	const server = normalizeServer(value.trim());
	const approved = await browser.permissions.request({ origins: [permissionFor(server)] });

	if (!approved) {
		return false;
	}

	await browser.storage.sync.set({ server });

	if (previous.server !== undefined && permissionFor(previous.server) !== permissionFor(server)) {
		await browser.permissions.remove({ origins: [permissionFor(previous.server)] });
	}

	return true;
}
