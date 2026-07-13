import { expect, test } from "@playwright/test";

const contract = "http://127.0.0.1:43174";

test.beforeEach(async ({ context, page, request }) => {
	await context.addCookies([
		{ name: "auth_session", value: "e2e-session", url: "http://127.0.0.1:43173" },
	]);
	page.on("pageerror", (error) => console.error("browser page error", error));
	page.on("console", (message) => {
		if (message.type() === "error") console.error("browser console error", message.text());
	});
	await request.post(`${contract}/__test/reset`);
});

test.describe("contract-mock caught failures", () => {
	for (const example of [
		{ route: "/", failedPath: "/api/v1/attention", surface: "cockpit", endpoint: "/attention" },
		{
			route: "/network",
			failedPath: "/api/v1/edge/sessions",
			surface: "network",
			endpoint: "/edge/sessions",
		},
		{
			route: "/updates",
			failedPath: "/api/v1/box-updates",
			surface: "updates",
			endpoint: "/box-updates",
		},
		{
			route: "/observability",
			failedPath: "/api/v1/catalog",
			surface: "observability",
			endpoint: "/catalog",
		},
	] as const) {
		test(`${example.surface} degrades and emits sanitized context`, async ({ page, request }) => {
			await request.post(`${contract}/__test/fail?path=${encodeURIComponent(example.failedPath)}`);
			await page.goto(example.route);
			await expect(page.locator("body")).toBeVisible();
			await expect
				.poll(async () => (await request.get(`${contract}/__test/envelopes`)).text())
				.toContain(example.endpoint);
			const sent = await (await request.get(`${contract}/__test/envelopes`)).text();
			expect(sent).toContain(example.surface);
			expect(sent).not.toContain("private upstream detail");
		});
	}
});

test("trusted login identity reaches the shell", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("Parker", { exact: true })).toBeVisible();
	await expect(page.getByText("@parker", { exact: true })).toBeVisible();
});

test("ask reaches the caller-scoped assistant contract", async ({ page, request }) => {
	await page.goto("/");
	await page.waitForTimeout(500);
	const ask = page.locator('input[aria-label="Ask Janet"]:visible');
	await ask.fill("What changed?");
	await ask.press("Enter");
	await expect
		.poll(async () => (await request.get(`${contract}/__test/messages`)).json())
		.toHaveLength(1);
});

test("named command reaches the contract op plane", async ({ page, request }) => {
	await page.goto("/network");
	await page.waitForTimeout(500);
	await page.getByRole("button", { name: "Redial" }).first().click();
	await expect
		.poll(async () => (await request.get(`${contract}/__test/operations`)).json())
		.toHaveLength(1);
	await expect(page.getByText("doorman.redial sent", { exact: false })).toBeVisible();
});

test("bus reconnects after a closed socket", async ({ page }) => {
	let connections = 0;
	await page.routeWebSocket("**/bus/ws", (socket) => {
		connections += 1;
		if (connections === 1) setTimeout(() => socket.close(), 50);
	});
	await page.goto("/");
	await page.evaluate(async () => {
		// @ts-expect-error Vite serves this browser-only module URL during the E2E run.
		const { connectBus } = await import("/src/lib/api/client.ts");
		(window as Window & { stopBus?: () => void }).stopBus = connectBus(
			() => [],
			() => {},
		);
	});
	await expect.poll(() => connections, { timeout: 4_000 }).toBeGreaterThan(1);
	await page.evaluate(() => (window as Window & { stopBus?: () => void }).stopBus?.());
});

test("successful but old contract state renders as stale", async ({ page }) => {
	await page.goto("/network");
	await expect(page.getByLabel("Tunnel incident for janet")).toContainText("line silent");
	await expect(page.getByRole("button", { name: /janet/ })).toContainText("unknown");
});

test("keyboard shortcuts focus ask and navigate", async ({ page }) => {
	await page.goto("/");
	await page.waitForTimeout(500);
	await page.keyboard.press("/");
	await expect
		.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")))
		.toBe("Ask Janet");
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.locator("body").click({ position: { x: 1, y: 1 } });
	await page.keyboard.press("g");
	await page.keyboard.press("o");
	await expect(page).toHaveURL(/\/observability$/);
});

test("phone lens keeps attention and ask while hiding desktop rail", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await expect(page.locator('input[aria-label="Ask Janet"]:visible')).toBeVisible();
	await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
	await expect(page.locator("aside.rail")).toBeHidden();
});
