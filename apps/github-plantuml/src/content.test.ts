import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type * as Content from "./content.ts";

vi.mock("./renderer.ts", () => ({ renderDiagram: vi.fn(() => Promise.resolve("rendered")) }));

let content: typeof Content;

beforeAll(async () => {
	vi.stubGlobal("chrome", {
		storage: {
			onChanged: { addListener: () => undefined },
			sync: { get: () => Promise.resolve({}) },
		},
	});

	content = await import("./content.ts");
	content.start();
});

afterEach(() => {
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

function addPullRequestDiff(): void {
	document.body.innerHTML = `
		<div class="file" data-tagsearch-path="diagram.puml" data-file-type="text" data-file-added="true">
			<div class="file-header"><a href="https://github.com/a/b/blob/0123456789012345678901234567890123456789/diagram.puml">diagram.puml</a><div class="file-actions"><div class="d-flex flex-justify-end"></div></div></div>
			<div class="js-file-content">source</div>
		</div>`;
}

function addReactPullRequestDiff(pathname = "/owner/repo/pull/1/changes"): void {
	history.replaceState({}, "", pathname);

	document.body.innerHTML = `
		<script type="application/json" data-target="react-app.embeddedData">{"payload":{"pullRequestsChangesRoute":{"pullRequest":{"number":1},"comparison":{"fullDiff":{"baseOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headOid":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}}}}</script>
		<div role="region"><header><button data-file-path="diagram.puml">diagram.puml</button></header><div><table aria-label="Diff for: diagram.puml"><tbody><tr><td>source</td></tr></tbody></table></div></div>`;
}

async function richDiffButton(): Promise<HTMLButtonElement> {
	await vi.waitFor(() => {
		expect(
			document.querySelector<HTMLButtonElement>("[aria-label='Display the rich diff']"),
		).not.toBeNull();
	});

	const rich = document.querySelector<HTMLButtonElement>("[aria-label='Display the rich diff']");

	if (rich === null) {
		throw new Error("Expected the rich diff button to be injected.");
	}

	return rich;
}

async function renderRichDiff(): Promise<void> {
	vi.stubGlobal("fetch", () =>
		Promise.resolve(new Response("@startuml\n@enduml", { status: 200 })),
	);

	(await richDiffButton()).click();

	await vi.waitFor(() => {
		expect(document.querySelector("[data-gh-plantuml='diff']")).not.toBeNull();
	});
}

function pendingFetch(): {
	calls: () => number;
	fetch: () => Promise<Response>;
	resolveAll: (response: Response) => void;
} {
	const resolveResponses: ((response: Response) => void)[] = [];

	return {
		calls: () => resolveResponses.length,
		fetch: () =>
			new Promise<Response>((resolve) => {
				resolveResponses.push(resolve);
			}),
		resolveAll: (response) => {
			if (resolveResponses.length === 0) {
				throw new Error("Expected a pending fetch.");
			}

			for (const resolve of resolveResponses) {
				resolve(response);
			}
		},
	};
}

describe("cleanup", () => {
	it("does not render a React pull request diff twice while its first render is pending", async () => {
		const pending = pendingFetch();

		vi.stubGlobal("fetch", pending.fetch);
		addReactPullRequestDiff();

		const rich = await richDiffButton();

		rich.click();
		rich.click();

		await vi.waitFor(() => {
			expect(pending.calls()).toBe(2);
		});

		pending.resolveAll(new Response("@startuml\n@enduml", { status: 200 }));

		await vi.waitFor(() => {
			expect(document.querySelectorAll("[data-gh-plantuml='diff']")).toHaveLength(1);
		});
	});

	it("keeps a classic pull request source diff visible when selected during a pending render", async () => {
		const pending = pendingFetch();

		vi.stubGlobal("fetch", pending.fetch);
		addPullRequestDiff();

		(await richDiffButton()).click();
		document.querySelector<HTMLButtonElement>("[aria-label='Display the source diff']")?.click();
		pending.resolveAll(new Response("@startuml\n@enduml", { status: 200 }));

		await vi.waitFor(() => {
			expect(document.querySelector("[data-gh-plantuml='diff']")).not.toBeNull();
		});

		expect(document.querySelector<HTMLElement>(".js-file-content")?.hidden).toBe(false);
		expect(document.querySelector<HTMLElement>("[data-gh-plantuml='diff']")?.hidden).toBe(true);

		expect(
			document
				.querySelector("[aria-label='Display the source diff']")
				?.getAttribute("aria-current"),
		).not.toBeNull();
	});

	it("injects React pull request changes and fetches its embedded comparison revisions", async () => {
		const fetched: string[] = [];

		vi.stubGlobal("fetch", (input: URL) => {
			fetched.push(input.toString());

			return Promise.resolve(new Response("@startuml\n@enduml", { status: 200 }));
		});

		addReactPullRequestDiff();

		(await richDiffButton()).click();

		await vi.waitFor(() => {
			expect(document.querySelector("[data-gh-plantuml='diff']")).not.toBeNull();
		});

		expect(fetched).toEqual(
			expect.arrayContaining([
				expect.stringContaining("/raw/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/diagram.puml"),
				expect.stringContaining("/raw/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/diagram.puml"),
			]),
		);
	});

	it("uses a commit parent for a React pull request commit subview", async () => {
		const fetched: string[] = [];

		vi.stubGlobal("fetch", (input: URL) => {
			fetched.push(input.toString());

			return Promise.resolve(new Response("@startuml\n@enduml", { status: 200 }));
		});

		addReactPullRequestDiff("/owner/repo/pull/1/changes/ccccccc");

		(await richDiffButton()).click();

		await vi.waitFor(() => {
			expect(fetched).toEqual(
				expect.arrayContaining([
					expect.stringContaining("/raw/ccccccc~1/diagram.puml"),
					expect.stringContaining("/raw/ccccccc/diagram.puml"),
				]),
			);
		});
	});

	it("uses both endpoints for a React pull request range subview", async () => {
		const fetched: string[] = [];

		vi.stubGlobal("fetch", (input: URL) => {
			fetched.push(input.toString());

			return Promise.resolve(new Response("@startuml\n@enduml", { status: 200 }));
		});

		addReactPullRequestDiff("/owner/repo/pull/1/changes/ddddddd..eeeeeee");

		(await richDiffButton()).click();

		await vi.waitFor(() => {
			expect(fetched).toEqual(
				expect.arrayContaining([
					expect.stringContaining("/raw/ddddddd/diagram.puml"),
					expect.stringContaining("/raw/eeeeeee/diagram.puml"),
				]),
			);
		});
	});

	it("restores rich diff source content that the extension hid", () => {
		document.body.innerHTML = `
			<div class="js-file-content" hidden data-gh-puml-hidden="false">source</div>
			<div data-gh-plantuml="diff">preview</div>`;

		content.cleanup();

		const source = document.querySelector<HTMLElement>(".js-file-content");

		expect(source?.hidden).toBe(false);
		expect(source?.dataset["ghPumlHidden"]).toBeUndefined();
	});

	it("does not insert a rich diff after cleanup invalidates a pending render", async () => {
		let resolveFetch: ((response: Response) => void) | undefined;

		vi.stubGlobal(
			"fetch",
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);

		addPullRequestDiff();

		await vi.waitFor(() => {
			expect(
				document.querySelector<HTMLButtonElement>("[aria-label='Display the rich diff']"),
			).not.toBeNull();
		});

		const rich = document.querySelector<HTMLButtonElement>("[aria-label='Display the rich diff']");

		rich?.click();

		await vi.waitFor(() => {
			expect(resolveFetch).toBeTypeOf("function");
		});

		content.cleanup();
		resolveFetch?.(new Response("@startuml\n@enduml", { status: 200 }));
		await Promise.resolve();
		await Promise.resolve();

		expect(document.querySelector<HTMLElement>(".js-file-content")?.hidden).toBe(false);
		expect(document.querySelector("[data-gh-plantuml='diff']")).toBeNull();
	});

	it("restores source after selecting rich twice", async () => {
		addPullRequestDiff();
		await renderRichDiff();

		(await richDiffButton()).click();
		document.querySelector<HTMLButtonElement>("[aria-label='Display the source diff']")?.click();

		expect(document.querySelector<HTMLElement>(".js-file-content")?.hidden).toBe(false);
	});

	it("restores source after cleanup following two rich selections", async () => {
		addPullRequestDiff();
		await renderRichDiff();

		(await richDiffButton()).click();
		content.cleanup();

		expect(document.querySelector<HTMLElement>(".js-file-content")?.hidden).toBe(false);
	});

	it("keeps an injected rich diff when only the query and hash change", async () => {
		addPullRequestDiff();
		await renderRichDiff();
		expect(document.querySelector(".js-rendered, .js-source")).toBeNull();

		history.pushState({}, "", `${location.pathname}?short_path=3335edd#diff-3335edd`);
		document.dispatchEvent(new Event("pjax:end"));
		await Promise.resolve();

		expect(document.querySelector("[data-gh-plantuml='diff']")).not.toBeNull();
		expect(document.querySelector("[data-gh-plantuml='diff-toggle']")).not.toBeNull();
	});
});
