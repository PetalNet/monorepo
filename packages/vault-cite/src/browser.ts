import { chromium } from "playwright";
import type { Browser } from "playwright";

import { CaptureError } from "./model.ts";
import type { Capture } from "./model.ts";
import { decoded, original } from "./network.ts";
import type { Network, Reply } from "./network.ts";

const assetLimit = 64 * 1024 ** 2;
const snapshotLimit = 32 * 1024 ** 2;
const deadline = 180_000;
// Omitting one of these lets the element inherit its parent's value. Any property
// missing here is omitted only when it equals both the tag default and the parent.
const inherited = [
	"border-collapse",
	"border-spacing",
	"caption-side",
	"caret-color",
	"color",
	"cursor",
	"direction",
	"empty-cells",
	"font-family",
	"font-feature-settings",
	"font-kerning",
	"font-size",
	"font-stretch",
	"font-style",
	"font-variant",
	"font-variation-settings",
	"font-weight",
	"hyphens",
	"letter-spacing",
	"line-height",
	"list-style-image",
	"list-style-position",
	"list-style-type",
	"orphans",
	"overflow-wrap",
	"quotes",
	"tab-size",
	"text-align",
	"text-indent",
	"text-rendering",
	"text-shadow",
	"text-transform",
	"visibility",
	"white-space",
	"widows",
	"word-break",
	"word-spacing",
	"writing-mode",
];

export async function snapshot(reply: Reply, network: Network): Promise<Capture> {
	const browser = await chromium.launch({
		headless: true,
		...(process.env["CITE_CHROMIUM_EXECUTABLE"]
			? { executablePath: process.env["CITE_CHROMIUM_EXECUTABLE"] }
			: {}),
	});
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new CaptureError("FAILED", `Page render exceeded ${String(deadline / 1000)} s`));
		}, deadline);
	});

	try {
		return await Promise.race([render(browser, reply, network), expired]);
	} finally {
		clearTimeout(timer);
		await browser.close();
	}
}

async function render(browser: Browser, reply: Reply, network: Network): Promise<Capture> {
	const context = await browser.newContext({
		serviceWorkers: "block",
		acceptDownloads: false,
		javaScriptEnabled: false,
	});
	const assets = new Map<string, Reply>([[reply.url, reply]]);
	let bytes = reply.body.length;
	let failure: Error | undefined;

	await context.route("**/*", async (route) => {
		try {
			const request = route.request();

			if (
				request.method() !== "GET" ||
				!["document", "stylesheet", "image", "font"].includes(request.resourceType())
			) {
				await route.abort();

				return;
			}

			const response = assets.get(request.url()) ?? (await network.get(request.url()));

			if (!assets.has(request.url())) {
				bytes += response.body.length;
				assets.set(request.url(), response);
			}

			if (bytes > assetLimit) {
				throw new CaptureError("FAILED", "Page exceeds 64 MiB capture limit");
			}

			await route.fulfill({
				status: 200,
				body: decoded(response),
				contentType: response.headers["content-type"] ?? "application/octet-stream",
			});
		} catch (error) {
			failure = error instanceof Error ? error : new Error("Browser resource capture failed");
			await route.abort();
		}
	});

	const page = await context.newPage();

	await page.goto(reply.url, { waitUntil: "load", timeout: 120_000 });

	if (failure) {
		throw failure;
	}

	const title = await page.title();
	// oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- Index rendered text, excluding hidden script and style contents.
	const text = await page.locator("body").innerText();
	const gated = await page
		.locator('input[type="password"], [class*="paywall"], [id*="paywall"]')
		.count();

	if (
		gated ||
		/sign in to (?:continue|read)|subscribe to (?:continue|read)|access denied|verify you are human|enable javascript and cookies/i.test(
			text,
		) ||
		text.trim().length < 80
	) {
		throw new CaptureError(
			"INACCESSIBLE",
			"Login, paywall, challenge, or unavailable page content",
		);
	}

	const authors = await page
		.locator('meta[name="citation_author"],meta[name="author"]')
		.evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute("content") ?? "").filter(Boolean),
		);
	// Capture rendered static content, not active scripts or a live dependency graph.
	// Computed styles preserve stylesheet effects; images become data URIs.
	const images: Record<string, string> = {};

	for (const [url, asset] of assets) {
		if (asset.headers["content-type"]?.startsWith("image/")) {
			images[url] =
				`data:${asset.headers["content-type"]};base64,${decoded(asset).toString("base64")}`;
		}
	}

	const html = await page.evaluate(
		({ imageData, inheritedNames, limit }) => {
			const clone = document.documentElement.cloneNode(true);

			if (!(clone instanceof HTMLElement)) {
				throw new Error("Missing document");
			}

			const originals = document.querySelectorAll("*");
			const copies = clone.querySelectorAll("*");
			// documentElement is outside querySelectorAll on the clone.
			const sourceNodes = [...originals].slice(1);
			// Inlining every computed property, custom properties included, multiplied large
			// pages ~1000x and exhausted the renderer. Inline only what the snapshot would not
			// reproduce on its own: a blank document supplies per-tag defaults and the root.
			const frame = document.createElement("iframe");

			frame.setAttribute("style", "position:absolute;left:-10000px;width:1024px;height:768px");
			document.documentElement.append(frame);
			const blank = frame.contentDocument;
			const blankWindow = frame.contentWindow;

			if (!blank || !blankWindow) {
				throw new Error("Missing blank document");
			}

			const inherits = new Set(inheritedNames);
			const values = (style: CSSStyleDeclaration) =>
				new Map([...style].map((key) => [key, style.getPropertyValue(key)]));
			const root = values(blankWindow.getComputedStyle(blank.documentElement));
			const body = values(blankWindow.getComputedStyle(blank.body));
			const tinted = blank.createElement("div");

			tinted.setAttribute("style", "color:rgb(1, 2, 3)");
			blank.body.append(tinted);
			// Properties whose default is currentColor, such as border colors.
			const followsColor = new Set(
				[...values(blankWindow.getComputedStyle(tinted))]
					.filter(([key, value]) => key !== "color" && value === "rgb(1, 2, 3)")
					.map(([key]) => key),
			);

			tinted.remove();
			const defaults = new Map<string, Map<string, string>>();
			const tagDefaults = (element: Element) => {
				const key = `${element.namespaceURI ?? ""} ${element.localName}`;
				let found = defaults.get(key);

				if (!found) {
					const probe = blank.createElementNS(element.namespaceURI, element.localName);

					blank.body.append(probe);
					found = values(blankWindow.getComputedStyle(probe));
					probe.remove();
					defaults.set(key, found);
				}

				return found;
			};
			let size = 0;

			for (const [index, node] of copies.entries()) {
				const source = sourceNodes[index];

				if (!source || !(node instanceof HTMLElement || node instanceof SVGElement)) {
					continue;
				}

				const style = getComputedStyle(source);
				const parent =
					source.parentElement && source.parentElement !== document.documentElement
						? getComputedStyle(source.parentElement)
						: undefined;
				const tag = tagDefaults(source);
				const declarations: string[] = [];

				for (const key of style) {
					// Computed values already substitute var(), so tokens add nothing but bytes.
					if (key.startsWith("--")) {
						continue;
					}

					const value = style.getPropertyValue(key);
					const fallback = tag.get(key);
					const inheritedValue = parent ? parent.getPropertyValue(key) : root.get(key);
					let reproduced: boolean;

					if (inherits.has(key)) {
						// Takes the parent's value unless the user agent styles this tag.
						reproduced = fallback === body.get(key) ? value === inheritedValue : value === fallback;
					} else if (followsColor.has(key) && fallback === tag.get("color")) {
						reproduced = value === style.color;
					} else {
						// Inheritance unknown: safe to omit only when both outcomes agree.
						reproduced = value === fallback && value === inheritedValue;
					}

					if (!reproduced) {
						declarations.push(`${key}:${value.replace(/url\([^)]*\)/g, "none")}`);
					}
				}

				const declaration = declarations.join(";");

				size += declaration.length;
				node.setAttribute("style", declaration);

				// oxlint-disable-next-line unicorn/no-useless-spread -- Attributes are removed during iteration; snapshot the live collection.
				for (const attribute of [...node.attributes]) {
					if (/^on/i.test(attribute.name)) {
						node.removeAttribute(attribute.name);
					}
				}

				if (node instanceof HTMLImageElement && source instanceof HTMLImageElement) {
					const data = imageData[source.currentSrc];

					if (data) {
						size += data.length;
						node.src = data;
					} else {
						node.removeAttribute("src");
					}

					node.removeAttribute("srcset");
				}

				if (node instanceof HTMLAnchorElement) {
					node.href = source.getAttribute("href")
						? new URL(source.getAttribute("href") ?? "", location.href).href
						: "";
				}

				if (size > limit) {
					frame.remove();

					return null;
				}
			}

			frame.remove();
			clone
				.querySelectorAll(
					"script,link,style,iframe,object,embed,video,audio,source,base,form,meta[http-equiv]",
				)
				.forEach((node) => {
					node.remove();
				});

			const policy = document.createElement("meta");

			policy.httpEquiv = "Content-Security-Policy";

			policy.content =
				"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

			clone.querySelector("head")?.prepend(policy);

			return `<!doctype html>\n${clone.outerHTML}`;
		},
		{ imageData: images, inheritedNames: inherited, limit: snapshotLimit },
	);

	if (html === null || html.length > snapshotLimit) {
		throw new CaptureError("FAILED", "Rendered snapshot exceeds 32 MiB limit");
	}

	await page.setContent(html, { waitUntil: "load" });
	const pdf = await page.pdf({ printBackground: true });

	return {
		canonicalId: reply.url,
		url: reply.url,
		title,
		authors,
		extractor: "playwright-static-snapshot-v2",
		artifacts: [
			original(reply),
			{ data: pdf, mime: "application/pdf", role: "DERIVED" },
			{ data: Buffer.from(html), mime: "text/html", role: "DERIVED" },
		],
	};
}
