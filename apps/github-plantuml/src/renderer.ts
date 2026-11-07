import { isDarkTheme, resolveInclude, type IncludeSource } from "./domain.ts";

declare const chrome: {
	runtime: {
		getURL: (path: string) => string;
		sendMessage: (message: unknown) => Promise<string | null>;
	};
	storage: {
		sync: { get: (keys: string[]) => Promise<{ server?: string }> };
		onChanged: { addListener: (listener: () => void) => void };
	};
};

interface FrameReply {
	type: "plantuml-ready" | "plantuml-result" | "plantuml-error" | "plantuml-include";
	id?: string;
	svg?: string;
	message?: string;
	path?: string;
	from?: string | null;
}

function isFrameReply(value: unknown): value is FrameReply {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const field = (key: string): unknown => Reflect.get(value, key);
	const type = field("type");

	return (
		typeof type === "string" &&
		["plantuml-ready", "plantuml-result", "plantuml-error", "plantuml-include"].includes(type) &&
		(field("id") === undefined || typeof field("id") === "string") &&
		(field("svg") === undefined || typeof field("svg") === "string") &&
		(field("message") === undefined || typeof field("message") === "string") &&
		(field("path") === undefined || typeof field("path") === "string") &&
		(field("from") === undefined || field("from") === null || typeof field("from") === "string")
	);
}

const pending = new Map<
	string,
	{
		resolve: (svg: string) => void;
		reject: (error: Error) => void;
		source: IncludeSource;
		includes: Map<string, IncludeSource>;
	}
>();
let frame: HTMLIFrameElement | undefined;
let frameReady = false;
const queued = new Map<string, { source: string }>();
let serverSettings: Promise<{ server?: string }> | undefined;

function configuredServer(): Promise<{ server?: string }> {
	serverSettings ??= chrome.storage.sync.get(["server"]);

	return serverSettings;
}

chrome.storage.onChanged.addListener(() => {
	serverSettings = undefined;
});

function extensionOrigin(): string {
	return new URL(chrome.runtime.getURL("/")).origin;
}

function rendererFrame(): HTMLIFrameElement {
	if (frame !== undefined) {
		return frame;
	}

	frame = document.createElement("iframe");
	frame.hidden = true;
	frame.src = chrome.runtime.getURL("renderer.html");
	document.documentElement.append(frame);

	return frame;
}

function sendRender(id: string, source: string): void {
	frame?.contentWindow?.postMessage(
		{
			type: "plantuml-render",
			id,
			source,
			dark: isDarkTheme(
				document.documentElement,
				matchMedia("(prefers-color-scheme: dark)").matches,
			),
		},
		extensionOrigin(),
	);
}

async function replyWithInclude(
	data: FrameReply,
	include: { rawUrl: URL; path: string },
): Promise<void> {
	const response = await fetch(include.rawUrl, { credentials: "same-origin" });

	frame?.contentWindow?.postMessage(
		{
			type: "plantuml-include-result",
			id: data.id,
			path: data.path,
			resolvedPath: include.path,
			text: response.ok ? await response.text() : "",
			error: response.ok ? undefined : `GitHub returned ${String(response.status)}`,
		},
		extensionOrigin(),
	);
}

function replyWithIncludeError(data: FrameReply, message: string): void {
	frame?.contentWindow?.postMessage(
		{
			type: "plantuml-include-result",
			id: data.id,
			path: data.path,
			resolvedPath: data.path,
			text: "",
			error: message,
		},
		extensionOrigin(),
	);
}

window.addEventListener("message", (event) => {
	if (event.origin !== extensionOrigin() || event.source !== frame?.contentWindow) {
		return;
	}

	if (!isFrameReply(event.data)) {
		return;
	}

	const data = event.data;

	if (data.type === "plantuml-ready") {
		frameReady = true;

		for (const [id, job] of queued) {
			queued.delete(id);
			sendRender(id, job.source);
		}

		return;
	}

	if (data.id === undefined) {
		return;
	}

	if (data.type === "plantuml-include" && data.path !== undefined) {
		const job = pending.get(data.id);
		const source =
			job === undefined
				? undefined
				: data.from === null || data.from === undefined
					? job.source
					: job.includes.get(data.from);
		const include = source === undefined ? null : resolveInclude(source, data.path);

		if (job === undefined) {
			return;
		}

		if (source === undefined) {
			replyWithIncludeError(
				data,
				`PlantUML requested an unknown containing file: ${data.from ?? "(root)"}.`,
			);

			return;
		}

		if (include === null) {
			replyWithIncludeError(data, `PlantUML include path is not allowed: ${data.path}.`);

			return;
		}

		job.includes.set(include.path, include);
		void replyWithInclude(data, include);

		return;
	}

	const job = pending.get(data.id);

	if (job === undefined) {
		return;
	}

	pending.delete(data.id);

	if (data.type === "plantuml-result" && data.svg !== undefined) {
		job.resolve(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg)}`);
	} else {
		job.reject(new Error(data.message ?? "PlantUML renderer failed."));
	}
});

export async function renderDiagram(source: string, includeSource: IncludeSource): Promise<string> {
	const { server } = await configuredServer();

	if (server === undefined) {
		return await renderLocally(source, includeSource);
	}

	try {
		const svg = await chrome.runtime.sendMessage({ type: "plantuml-server-render", source });

		return svg ?? (await renderLocally(source, includeSource));
	} catch {
		return await renderLocally(source, includeSource);
	}
}

function renderLocally(source: string, includeSource: IncludeSource): Promise<string> {
	return new Promise((resolve, reject) => {
		const id = crypto.randomUUID();

		pending.set(id, { resolve, reject, source: includeSource, includes: new Map() });
		rendererFrame();

		if (frameReady) {
			sendRender(id, source);
		} else {
			queued.set(id, { source });
		}
	});
}
