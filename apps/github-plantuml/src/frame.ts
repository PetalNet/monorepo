interface RenderModule {
	renderToString: (
		lines: string[],
		ok: (svg: string) => void,
		fail: (error: string) => void,
		options: { dark: boolean; maxSvgSize: number },
	) => void;
}

type FrameMessage =
	| { type: "plantuml-render"; id: string; source: string; dark: boolean }
	| {
			type: "plantuml-include-result";
			id: string;
			path: string;
			resolvedPath: string;
			text: string;
			error?: string;
	  };

function isFrameMessage(value: unknown): value is FrameMessage {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const field = (key: string): unknown => Reflect.get(value, key);

	if (field("type") === "plantuml-render") {
		return (
			typeof field("id") === "string" &&
			typeof field("source") === "string" &&
			typeof field("dark") === "boolean"
		);
	}

	return (
		field("type") === "plantuml-include-result" &&
		typeof field("id") === "string" &&
		typeof field("path") === "string" &&
		typeof field("resolvedPath") === "string" &&
		typeof field("text") === "string" &&
		(field("error") === undefined || typeof field("error") === "string")
	);
}

declare global {
	var Viz: unknown;
	var PLANTUML_VIZ: unknown;
	var PLANTUML_FILE_LOADER:
		| ((
				path: string,
				from: string | null,
				ok: (id: string, text: string) => void,
				fail: (message: string) => void,
		  ) => void)
		| undefined;
}

let engine: Promise<RenderModule> | undefined;
const includes = new Map<
	string,
	{ ok: (id: string, text: string) => void; fail: (message: string) => void }
>();
const renderQueue: Extract<FrameMessage, { type: "plantuml-render" }>[] = [];
let rendering = false;

function isRenderModule(value: unknown): value is RenderModule {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "renderToString") === "function"
	);
}

async function importEngine(): Promise<RenderModule> {
	const asset = "./plantuml/plantuml.js";

	globalThis.PLANTUML_VIZ = globalThis.Viz;
	const loaded: unknown = await import(/* @vite-ignore */ asset);

	if (!isRenderModule(loaded)) {
		throw new Error("PlantUML renderer module is invalid.");
	}

	return loaded;
}

function loadEngine(): Promise<RenderModule> {
	engine ??= importEngine();

	return engine;
}

function startNextRender(): void {
	const message = renderQueue.shift();

	if (message === undefined) {
		rendering = false;

		return;
	}

	rendering = true;
	void render(message);
}

function finishRender(): void {
	startNextRender();
}

async function render(message: Extract<FrameMessage, { type: "plantuml-render" }>): Promise<void> {
	const { id, source, dark } = message;

	globalThis.PLANTUML_FILE_LOADER = (path, from, ok, fail) => {
		includes.set(`${id}:${path}`, { ok, fail });
		parent.postMessage({ type: "plantuml-include", id, path, from }, "https://github.com");
	};

	try {
		const module = await loadEngine();

		module.renderToString(
			source.split(/\r\n|\r|\n/u),
			(svg) => {
				parent.postMessage({ type: "plantuml-result", id, svg }, "https://github.com");
				finishRender();
			},
			(error) => {
				parent.postMessage({ type: "plantuml-error", id, message: error }, "https://github.com");
				finishRender();
			},
			{ dark, maxSvgSize: 8192 },
		);
	} catch (error: unknown) {
		parent.postMessage(
			{
				type: "plantuml-error",
				id,
				message: error instanceof Error ? error.message : String(error),
			},
			"https://github.com",
		);

		finishRender();
	}
}

window.addEventListener("message", (event) => {
	if (event.source !== parent || event.origin !== "https://github.com") {
		return;
	}

	if (!isFrameMessage(event.data)) {
		return;
	}

	const data = event.data;

	if (data.type === "plantuml-include-result") {
		const key = `${data.id}:${data.path}`;
		const include = includes.get(key);

		if (include === undefined) {
			return;
		}

		includes.delete(key);

		if (data.error === undefined) {
			include.ok(data.resolvedPath, data.text);
		} else {
			include.fail(data.error);
		}

		return;
	}

	renderQueue.push(data);

	if (!rendering) {
		startNextRender();
	}
});

parent.postMessage({ type: "plantuml-ready" }, "https://github.com");
