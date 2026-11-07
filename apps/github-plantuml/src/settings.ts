export interface Settings {
	server?: string;
}

declare const chrome: {
	storage: {
		sync: {
			get: (keys: string[]) => Promise<Settings>;
			set: (values: Settings) => Promise<void>;
			remove: (keys: string[]) => Promise<void>;
		};
		onChanged: { addListener: (listener: () => void) => void };
	};
	permissions: {
		request: (details: { origins: string[] }) => Promise<boolean>;
		remove: (details: { origins: string[] }) => Promise<boolean>;
	};
};

let savedSettings: Promise<Settings> | undefined;

export function settings(): Promise<Settings> {
	savedSettings ??= chrome.storage.sync.get(["server"]);

	return savedSettings;
}

chrome.storage.onChanged.addListener(() => {
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
		await chrome.storage.sync.remove(["server"]);

		if (previous.server !== undefined) {
			await chrome.permissions.remove({ origins: [permissionFor(previous.server)] });
		}

		return true;
	}

	const server = normalizeServer(value.trim());
	const approved = await chrome.permissions.request({ origins: [permissionFor(server)] });

	if (!approved) {
		return false;
	}

	await chrome.storage.sync.set({ server });

	if (previous.server !== undefined && permissionFor(previous.server) !== permissionFor(server)) {
		await chrome.permissions.remove({ origins: [permissionFor(previous.server)] });
	}

	return true;
}
