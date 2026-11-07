import "./styles.css";
import {
	isPlantUmlPath,
	parseBlobUrl,
	rawUrlForCurrentBlob,
	type IncludeSource,
} from "./domain.ts";
import { setFileMode } from "./file-view.ts";
import { renderDiagram } from "./renderer.ts";
import { createDiff, createError, createPreview, richIcon, sourceIcon } from "./view.ts";

const marker = "data-gh-plantuml";
const hiddenByExtension = "ghPumlHidden";
let pageKey = "";

async function fetchText(url: URL): Promise<string> {
	const response = await fetch(url, { credentials: "same-origin" });

	if (!response.ok) {
		throw new Error(`GitHub returned ${String(response.status)} for ${url.pathname}`);
	}

	return response.text();
}

function fileSection(): HTMLElement | null {
	return document.querySelector("section[aria-labelledby*='file-name-id']");
}

async function populateFilePreview(
	preview: HTMLElement,
	raw: URL,
	path: string,
	section: HTMLElement,
): Promise<void> {
	try {
		const svg = await renderDiagram(await fetchText(raw), { rawUrl: raw, path });

		preview.replaceChildren(createPreview(svg, path));
		setFileMode(section, preview, "preview");
	} catch (error: unknown) {
		preview.replaceChildren(createError(error instanceof Error ? error.message : String(error)));
	}
}

function injectFile(): void {
	const raw = rawUrlForCurrentBlob();
	const blob = raw === null ? null : parseBlobUrl(new URL(location.href));
	const section = fileSection();

	if (
		raw === null ||
		blob === null ||
		section === null ||
		!isPlantUmlPath(blob.path) ||
		section.querySelector(`[${marker}='preview']`) !== null
	) {
		return;
	}

	const list = document.querySelector<HTMLUListElement>("ul[aria-label='File view']");
	const codeItem = list?.querySelector<HTMLLIElement>("li:has(button[aria-pressed])") ?? null;

	if (list === null || codeItem === null) {
		return;
	}

	const item = codeItem.cloneNode(true);

	if (!(item instanceof HTMLLIElement)) {
		return;
	}

	item.setAttribute(marker, "preview-item");
	item.dataset["selected"] = "";
	const button = item.querySelector<HTMLButtonElement>("button");
	const text = item.querySelector<HTMLElement>("[data-text]");

	if (button === null || text === null) {
		return;
	}

	button.setAttribute("aria-pressed", "true");
	text.dataset["text"] = "Preview";
	text.textContent = "Preview";
	list.prepend(item);
	const preview = document.createElement("div");

	preview.setAttribute(marker, "preview");
	preview.className = "gh-puml-file-preview";
	section.append(preview);

	button.addEventListener("click", () => {
		setFileMode(section, preview, "preview");
	});

	codeItem.querySelector("button")?.addEventListener("click", () => {
		setFileMode(section, preview, "code");
	});

	setFileMode(section, preview, "preview");
	void populateFilePreview(preview, raw, blob.path, section);
}

function shaFrom(element: HTMLElement, kind: "head" | "base"): string | null {
	if (kind === "head") {
		return (
			element
				.querySelector<HTMLAnchorElement>(".file-header a[href*='/blob/']")
				?.href.match(/\/blob\/([a-f0-9]{40})\//iu)?.[1] ?? null
		);
	}

	return (
		/base_sha=([a-f0-9]{40})/iu.exec(element.outerHTML)?.[1] ??
		// The PR page records the compared range's start (the merge base for "all commits") in
		// its embedded analytics and form data, not on each file.
		/(?:start_commit_oid|comparison_start_oid|base_sha)(?:&quot;|["':=\s])+([a-f0-9]{40})/iu.exec(
			document.documentElement.innerHTML,
		)?.[1] ??
		null
	);
}

function rawFor(file: HTMLElement, sha: string, path: string): URL | null {
	const href = file.querySelector<HTMLAnchorElement>(".file-header a[href*='/blob/']")?.href;

	if (href === undefined) {
		return null;
	}

	const url = new URL(href);
	const parts = url.pathname.split("/");
	const index = parts.indexOf("blob");

	if (index === -1) {
		return null;
	}

	url.pathname = `${parts.slice(0, index).join("/")}/raw/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;

	return url;
}

function oldPathFor(file: HTMLElement, currentPath: string): string | null {
	const explicit =
		file.dataset["oldPath"] ?? file.dataset["previousPath"] ?? file.dataset["oldFilePath"];

	if (explicit !== undefined) {
		return explicit;
	}

	const header = file.querySelector<HTMLElement>(".file-header, h3");
	const text = header === null ? "" : header.textContent.replaceAll("\u200E", "");
	const screenReaderText =
		header?.querySelector(".sr-only")?.textContent.replaceAll("\u200E", "") ?? "";
	const renamedForScreenReaders = /(.+)\s+renamed to\s+(.+)/u.exec(screenReaderText);

	if (renamedForScreenReaders !== null) {
		return renamedForScreenReaders[2]?.trim() === currentPath
			? (renamedForScreenReaders[1]?.trim() ?? null)
			: null;
	}

	const renamed = /(.+)\s+→\s+(.+)/u.exec(text);

	if (renamed === null) {
		return text.includes("→") ? null : currentPath;
	}

	return renamed[2]?.trim() === currentPath ? (renamed[1]?.trim() ?? null) : null;
}

async function fetchDiffDiagram(
	source: IncludeSource,
	tolerateNotFound: boolean,
): Promise<string | null> {
	const response = await fetch(source.rawUrl, { credentials: "same-origin" });

	if (response.status === 404 && tolerateNotFound) {
		return null;
	}

	if (!response.ok) {
		throw new Error(`GitHub returned ${String(response.status)} for ${source.rawUrl.pathname}`);
	}

	return renderDiagram(await response.text(), source);
}

interface DiffState {
	pending: boolean;
	selectedRich: boolean;
	view?: HTMLElement;
}

function setDiffMode({
	content,
	rich,
	source,
	state,
	selectedRich,
}: {
	content: HTMLElement;
	rich: HTMLButtonElement;
	source: HTMLButtonElement;
	state: DiffState;
	selectedRich: boolean;
}): void {
	state.selectedRich = selectedRich;
	source.classList.toggle("selected", !selectedRich);
	rich.classList.toggle("selected", selectedRich);
	source.toggleAttribute("aria-current", !selectedRich);
	rich.toggleAttribute("aria-current", selectedRich);
	setDiffContentVisibility(content, selectedRich);

	if (state.view !== undefined) {
		state.view.hidden = !selectedRich;
	}
}

async function populateDiff(
	sources: readonly [IncludeSource | null, IncludeSource | null],
	content: HTMLElement,
	set: (rich: boolean) => void,
	state: DiffState,
	isLive: () => boolean,
	tolerateOneSidedNotFound = false,
): Promise<void> {
	try {
		const diagrams = await Promise.all(
			sources.map(async (source) =>
				source === null ? null : fetchDiffDiagram(source, tolerateOneSidedNotFound),
			),
		);

		if (tolerateOneSidedNotFound && diagrams[0] === null && diagrams[1] === null) {
			throw new Error("GitHub returned 404 for both sides of this commit diff.");
		}

		state.view = createDiff(diagrams[0] ?? null, diagrams[1] ?? null);
	} catch (error: unknown) {
		state.view = createError(error instanceof Error ? error.message : String(error));
	}

	state.pending = false;

	if (!isLive()) {
		return;
	}

	state.view.setAttribute(marker, "diff");
	content.after(state.view);
	set(state.selectedRich);
}

function setDiffContentVisibility(content: HTMLElement, rich: boolean): void {
	if (rich) {
		if (!Object.hasOwn(content.dataset, hiddenByExtension)) {
			content.dataset[hiddenByExtension] = String(content.hidden);
		}

		content.hidden = true;

		return;
	}

	content.hidden = content.dataset[hiddenByExtension] === "true";
	Reflect.deleteProperty(content.dataset, hiddenByExtension);
}

function injectDiffs(): void {
	for (const file of document.querySelectorAll<HTMLElement>(
		"div.file[data-tagsearch-path][data-file-type]",
	)) {
		const path = file.dataset["tagsearchPath"];

		if (path === undefined) {
			continue;
		}

		if (!isPlantUmlPath(path) || file.querySelector(`[${marker}='diff-toggle']`) !== null) {
			continue;
		}

		const actions = file.querySelector<HTMLElement>(
			".file-header .file-actions .d-flex.flex-justify-end",
		);
		const content = file.querySelector<HTMLElement>(".js-file-content");

		if (actions === null || content === null) {
			continue;
		}

		const group = document.createElement("span");

		group.className = "BtnGroup min-width-0 flex-self-center";
		group.setAttribute(marker, "diff-toggle");
		const source = document.createElement("button");

		source.type = "button";
		source.className = "btn btn-sm BtnGroup-item tooltipped tooltipped-s source selected";
		source.setAttribute("aria-label", "Display the source diff");
		source.setAttribute("aria-current", "true");
		source.append(sourceIcon());
		const rich = document.createElement("button");

		rich.type = "button";
		rich.className = "btn btn-sm BtnGroup-item tooltipped tooltipped-s rendered";
		rich.setAttribute("aria-label", "Display the rich diff");
		rich.append(richIcon());
		group.append(source, rich);
		actions.prepend(group);
		const state: DiffState = { pending: false, selectedRich: false };
		const set = (selectedRich: boolean) => {
			setDiffMode({ content, rich, selectedRich, source, state });
		};

		source.addEventListener("click", () => {
			set(false);
		});

		rich.addEventListener("click", () => {
			set(true);

			if (state.view !== undefined) {
				return;
			}

			if (state.pending) {
				return;
			}

			state.pending = true;

			const head = shaFrom(file, "head");
			const base = shaFrom(file, "base");
			const deleted = file.dataset["fileDeleted"] === "true";
			const added = file.dataset["fileAdded"] === "true";
			const beforePath = oldPathFor(file, path);
			const sources: [IncludeSource | null, IncludeSource | null] = [
				!added && base && beforePath !== null
					? (() => {
							const rawUrl = rawFor(file, base, beforePath);

							return rawUrl === null ? null : { rawUrl, path: beforePath };
						})()
					: null,
				!deleted && head
					? (() => {
							const rawUrl = rawFor(file, head, path);

							return rawUrl === null ? null : { rawUrl, path };
						})()
					: null,
			];

			if (
				(!added && (base === null || beforePath === null || sources[0] === null)) ||
				(!deleted && (head === null || sources[1] === null))
			) {
				state.view = createError(
					"GitHub did not provide the revision or path required for this diff.",
				);

				state.pending = false;

				content.after(state.view);
				set(state.selectedRich);

				return;
			}

			void populateDiff(
				sources,
				content,
				set,
				state,
				() => rich.isConnected && content.isConnected,
			);
		});
	}
}

type RevisionPair = readonly [base: string, head: string];
type ReactDiffRevisions =
	| { kind: "commit"; shas: RevisionPair }
	| { kind: "comparison"; shas: RevisionPair };

function reactDiffRawUrl(sha: string, path: string): URL | null {
	const match = /^\/([^/]+)\/([^/]+)\//u.exec(location.pathname);

	if (match?.[1] === undefined || match[2] === undefined) {
		return null;
	}

	return new URL(
		`/${match[1]}/${match[2]}/raw/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`,
		location.origin,
	);
}

function sourceFor(rawUrl: URL | null, path: string | null): IncludeSource | null {
	return rawUrl === null || path === null ? null : { rawUrl, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function property(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

function fullDiffShas(value: unknown): RevisionPair | null {
	const fullDiff = property(value, "fullDiff");
	const base = property(fullDiff, "baseOid");
	const head = property(fullDiff, "headOid");

	return typeof base === "string" && typeof head === "string" ? [base, head] : null;
}

function pullRequestShasFromDocument(root: ParentNode, number: string): RevisionPair | null {
	const script = root.querySelector(
		"script[type='application/json'][data-target='react-app.embeddedData']",
	);

	if (script === null) {
		return null;
	}

	try {
		const payload = property(JSON.parse(script.textContent), "payload");
		const route = property(payload, "pullRequestsChangesRoute");
		const pullRequest = property(route, "pullRequest");

		if (String(property(pullRequest, "number")) !== number) {
			return null;
		}

		return (
			fullDiffShas(property(route, "comparison")) ??
			fullDiffShas(property(pullRequest, "comparison"))
		);
	} catch {
		return null;
	}
}

function pullRequestRoute(): readonly [owner: string, repository: string, number: string] | null {
	const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:changes|files)(?:\/.*)?$/u.exec(
		location.pathname,
	);

	return match?.[1] === undefined || match[2] === undefined || match[3] === undefined
		? null
		: [match[1], match[2], match[3]];
}

async function pullRequestShas(
	route: readonly [string, string, string],
): Promise<RevisionPair | null> {
	const embedded = pullRequestShasFromDocument(document, route[2]);

	if (embedded !== null) {
		return embedded;
	}

	try {
		const html = await fetchText(
			new URL(`/${route[0]}/${route[1]}/pull/${route[2]}/changes`, location.origin),
		);

		return pullRequestShasFromDocument(
			new DOMParser().parseFromString(html, "text/html"),
			route[2],
		);
	} catch {
		return null;
	}
}

async function reactDiffRevisions(): Promise<ReactDiffRevisions | null> {
	const commit = /\/commit\/([a-f0-9]{7,40})$/iu.exec(location.pathname)?.[1];

	if (commit !== undefined) {
		// GitHub resolves `<sha>~1` in raw URLs, and its commit view diffs against the first parent.
		return { kind: "commit", shas: [`${commit}~1`, commit] };
	}

	const route = pullRequestRoute();

	if (route === null) {
		return null;
	}

	const suffix = /\/pull\/\d+\/(?:changes|files)\/([a-f0-9]{7,40}(?:\.\.[a-f0-9]{7,40})?)$/iu.exec(
		location.pathname,
	)?.[1];

	if (suffix !== undefined) {
		const [base, head] = suffix.split("..");

		if (base !== undefined && head !== undefined) {
			return { kind: "comparison", shas: [base, head] };
		}

		return { kind: "commit", shas: [`${suffix}~1`, suffix] };
	}

	const shas = await pullRequestShas(route);

	return shas === null ? null : { kind: "comparison", shas };
}

function commitFileState(
	table: HTMLTableElement,
	region: HTMLElement,
): { added: boolean; deleted: boolean } {
	const elements = [table, region];
	const text = region.textContent;

	return {
		added:
			elements.some((element) => element.dataset["fileAdded"] === "true") ||
			text.includes("This file was added."),
		deleted:
			elements.some((element) => element.dataset["fileDeleted"] === "true") ||
			text.includes("This file was deleted."),
	};
}

function injectReactDiffs(): void {
	if (
		!/^\/[^/]+\/[^/]+\/commit\/[a-f0-9]{7,40}$/iu.test(location.pathname) &&
		pullRequestRoute() === null
	) {
		return;
	}

	for (const table of document.querySelectorAll<HTMLTableElement>(
		"table[aria-label^='Diff for: ']",
	)) {
		const path = table.getAttribute("aria-label")?.slice("Diff for: ".length);
		const region = table.closest<HTMLElement>("[role='region']");
		const content = table.parentElement;

		if (
			path === undefined ||
			region === null ||
			content === null ||
			!isPlantUmlPath(path) ||
			region.querySelector(`[${marker}='diff-toggle']`) !== null
		) {
			continue;
		}

		const filePath = path;
		const actionButton = region.querySelector<HTMLElement>("button[data-file-path]");

		if (actionButton === null) {
			continue;
		}

		const actions = actionButton.parentElement;

		if (actions === null) {
			continue;
		}

		const group = document.createElement("span");

		group.className = "BtnGroup min-width-0 flex-self-center";
		group.setAttribute(marker, "diff-toggle");
		const source = document.createElement("button");

		source.type = "button";
		source.className = "btn btn-sm BtnGroup-item tooltipped tooltipped-s source selected";
		source.setAttribute("aria-label", "Display the source diff");
		source.setAttribute("aria-current", "true");
		source.append(sourceIcon());
		const rich = document.createElement("button");

		rich.type = "button";
		rich.className = "btn btn-sm BtnGroup-item tooltipped tooltipped-s rendered";
		rich.setAttribute("aria-label", "Display the rich diff");
		rich.append(richIcon());
		group.append(source, rich);
		actions.append(group);
		const state: DiffState = { pending: false, selectedRich: false };
		const set = (selectedRich: boolean) => {
			setDiffMode({ content, rich, selectedRich, source, state });
		};

		source.addEventListener("click", () => {
			set(false);
		});

		rich.addEventListener("click", () => {
			set(true);

			if (state.view !== undefined) {
				return;
			}

			if (state.pending) {
				return;
			}

			state.pending = true;

			void (async () => {
				const revisions = await reactDiffRevisions();
				const { added, deleted } = commitFileState(table, region);
				const beforePath = oldPathFor(region, filePath);
				const sources = (() => {
					if (revisions === null) {
						return null;
					}

					const beforeRawUrl =
						added || beforePath === null ? null : reactDiffRawUrl(revisions.shas[0], beforePath);
					const afterRawUrl = deleted ? null : reactDiffRawUrl(revisions.shas[1], filePath);

					const before = sourceFor(beforeRawUrl, beforePath);
					const after = sourceFor(afterRawUrl, filePath);

					return (!added && before === null) || (!deleted && after === null)
						? null
						: ([added ? null : before, deleted ? null : after] satisfies [
								IncludeSource | null,
								IncludeSource | null,
							]);
				})();
				const tolerateOneSidedNotFound = revisions?.kind === "commit";

				if (!rich.isConnected || !content.isConnected) {
					state.pending = false;

					return;
				}

				if (sources === null) {
					state.view = createError("GitHub did not provide the revisions required for this diff.");
					state.pending = false;
					content.after(state.view);
					set(state.selectedRich);

					return;
				}

				void populateDiff(
					sources,
					content,
					set,
					state,
					() => rich.isConnected && content.isConnected,
					tolerateOneSidedNotFound,
				);
			})();
		});
	}
}

export function cleanup(): void {
	for (const preview of document.querySelectorAll<HTMLElement>(`[${marker}='preview']`)) {
		const section = preview.parentElement;

		if (section !== null) {
			setFileMode(section, preview, "code");
		}
	}

	for (const element of document.querySelectorAll(`[${marker}]`)) {
		element.remove();
	}

	for (const content of document.querySelectorAll<HTMLElement>(`[data-gh-puml-hidden]`)) {
		content.hidden = content.dataset[hiddenByExtension] === "true";
		Reflect.deleteProperty(content.dataset, hiddenByExtension);
	}

	for (const element of document.querySelectorAll<HTMLElement>(
		"section[aria-labelledby*='file-name-id'] > [hidden]",
	)) {
		element.hidden = false;
	}
}

function inject(): void {
	if (pageKey !== location.pathname) {
		cleanup();
		pageKey = location.pathname;
	}

	injectFile();
	injectDiffs();
	injectReactDiffs();
}

let scheduled = false;

function schedule(): void {
	if (!scheduled) {
		scheduled = true;

		queueMicrotask(() => {
			scheduled = false;
			inject();
		});
	}
}

new MutationObserver(schedule).observe(document.documentElement, {
	childList: true,
	subtree: true,
});

const themeObserver = new MutationObserver(() => {
	cleanup();
	schedule();
});

themeObserver.observe(document.documentElement, {
	attributes: true,
	attributeFilter: ["data-color-mode", "data-dark-theme", "data-light-theme"],
});

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	cleanup();
	schedule();
});

document.addEventListener("turbo:load", schedule);
document.addEventListener("pjax:end", schedule);
window.addEventListener("popstate", schedule);
schedule();
