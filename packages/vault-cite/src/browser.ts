import { chromium } from "playwright";

import { CaptureError } from "./model.ts";
import type { Capture } from "./model.ts";
import { decoded, original } from "./network.ts";
import type { Network, Reply } from "./network.ts";

export async function snapshot(reply: Reply, network: Network): Promise<Capture> {
	const browser = await chromium.launch({
		headless: true,
		...(process.env["CITE_CHROMIUM_EXECUTABLE"]
			? { executablePath: process.env["CITE_CHROMIUM_EXECUTABLE"] }
			: {}),
	});

	try {
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

				if (bytes > 64 * 1024 ** 2) {
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

		const html = await page.evaluate((imageData) => {
			const clone = document.documentElement.cloneNode(true);

			if (!(clone instanceof HTMLElement)) {
				throw new Error("Missing document");
			}

			const originals = document.querySelectorAll("*");
			const copies = clone.querySelectorAll("*");
			// documentElement is outside querySelectorAll on the clone.
			const sourceNodes = [...originals].slice(1);

			copies.forEach((node, index) => {
				const source = sourceNodes[index];

				if (!source || !(node instanceof HTMLElement || node instanceof SVGElement)) {
					return;
				}

				const style = getComputedStyle(source);

				node.setAttribute(
					"style",
					[...style]
						.map((key) => `${key}:${style.getPropertyValue(key).replace(/url\([^)]*\)/g, "none")}`)
						.join(";"),
				);

				// oxlint-disable-next-line unicorn/no-useless-spread -- Attributes are removed during iteration; snapshot the live collection.
				for (const attribute of [...node.attributes]) {
					if (/^on/i.test(attribute.name)) {
						node.removeAttribute(attribute.name);
					}
				}

				if (node instanceof HTMLImageElement && source instanceof HTMLImageElement) {
					const data = imageData[source.currentSrc];

					if (data) {
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
			});

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
		}, images);

		await page.setContent(html, { waitUntil: "load" });
		const pdf = await page.pdf({ printBackground: true });

		return {
			canonicalId: reply.url,
			url: reply.url,
			title,
			authors,
			extractor: "playwright-static-snapshot-v1",
			artifacts: [
				original(reply),
				{ data: pdf, mime: "application/pdf", role: "DERIVED" },
				{ data: Buffer.from(html), mime: "text/html", role: "DERIVED" },
			],
		};
	} finally {
		await browser.close();
	}
}
