import { mkdir } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { SignJWT } from "jose";
const evidence = "test/evidence";
async function shot(page: Page, info: TestInfo, name: string) {
	await mkdir(`${evidence}/${info.project.name}`, { recursive: true });
	await page.screenshot({
		path: `${evidence}/${info.project.name}/${name}.png`,
		fullPage: name !== "12-curation",
		scale: "css",
	});
}
async function begin(page: Page) {
	await page.goto("/");
	if (page.context().browser()?.browserType().name() === "webkit") await fakeWebkit(page);
	await page.getByLabel("Your first name").fill("Test Voice");
	await page.getByRole("checkbox").check();
	await page.getByRole("button", { name: "Start recording" }).click();
	await expect(page.getByRole("button", { name: "Record", exact: true })).toBeVisible();
}
async function fakeWebkit(page: Page) {
	await page.evaluate(() => {
		Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
			configurable: true,
			value: () => {
				const context = new AudioContext();
				const oscillator = context.createOscillator();
				const gain = context.createGain();
				gain.gain.value = 0.2;
				const destination = context.createMediaStreamDestination();
				oscillator.connect(gain).connect(destination);
				oscillator.start();
				void context.resume();
				return Promise.resolve(destination.stream);
			},
		});
	});
}
async function take(page: Page) {
	await page.getByRole("button", { name: "Record", exact: true }).click();
	await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
	await page.waitForTimeout(400);
	await page.getByRole("button", { name: "Stop recording" }).click();
	await expect(page.getByRole("button", { name: "Use this take" })).toBeVisible();
}
test("full 40 phrase session, playback, more sets and screenshots", async ({ page }, info) => {
	test.setTimeout(90000);
	await page.goto("/");
	await shot(page, info, "01-landing");
	await begin(page);
	await shot(page, info, "02-microphone-ready");

	async function step(i: number): Promise<void> {
		if (i >= 40) return;
		await page.getByRole("button", { name: "Record", exact: true }).click();
		await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
		if (i === 0) await shot(page, info, "03-recording");
		await page.waitForTimeout(260);
		await page.getByRole("button", { name: "Stop recording" }).click();
		await expect(page.getByRole("button", { name: "Use this take" })).toBeVisible();
		if (i === 0) {
			await page.locator("audio").evaluate(async (a: HTMLAudioElement) => {
				await a.play();
			});
			await shot(page, info, "04-playback");
		}
		if (i === 25) await shot(page, info, "05-near-miss");
		await page.getByRole("button", { name: "Use this take" }).click();
		await step(i + 1);
	}
	await step(0);
	await expect(page.getByRole("heading", { name: /That’s a wrap/ })).toBeVisible();
	await expect(page.getByText("Your takes have uploaded. You can close this page.")).toBeVisible({
		timeout: 30000,
	});
	await shot(page, info, "06-thank-you");
	await page.getByRole("button", { name: "Record another set" }).click();
	await expect(page.getByText("Phrase 1 of 40")).toBeVisible();
});
test("redo, skip, offline upload recovery and reload keep the session", async ({
	page,
	context,
}, info) => {
	await begin(page);
	await take(page);
	await page.getByRole("button", { name: "Redo", exact: true }).click();
	await expect(page.getByText("Phrase 1 of 40")).toBeVisible();
	await take(page);
	await page.route("**/api/clips?**", (route) => route.abort("internetdisconnected"));
	await page.getByRole("button", { name: "Use this take" }).click();
	await expect(page.getByRole("status").filter({ hasText: "saved on this device" })).toBeVisible();
	await shot(page, info, "07-offline-queue");
	await page.reload();
	await expect(page.getByText("Phrase 2 of 40")).toBeVisible();
	await expect(page.getByRole("status").filter({ hasText: "saved on this device" })).toBeVisible();
	await shot(page, info, "08-resumed");
	await page.unroute("**/api/clips?**");
	await context.setOffline(true);
	await context.setOffline(false);
	await expect(page.getByText("All accepted takes uploaded")).toBeVisible();
	await page.getByRole("button", { name: "Skip this phrase" }).click();
	await expect(page.getByText("Phrase 3 of 40")).toBeVisible();
	await shot(page, info, "09-skip");
});
test("permission denied has recovery guidance", async ({ page }, info) => {
	await begin(page);
	await page.evaluate(() => {
		Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
			configurable: true,
			value: () => Promise.reject(new DOMException("Denied", "NotAllowedError")),
		});
	});
	await page.getByRole("button", { name: "Record", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Microphone access is blocked");
	await expect(page.getByRole("button", { name: "Record", exact: true })).toBeEnabled();
	await shot(page, info, "10-mic-denied");
});
test("keyboard, labels, contrast and responsive overflow", async ({ page }, info) => {
	await begin(page);
	await page.locator("h1").click();
	await page.keyboard.press("Space");
	await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
	await page.waitForTimeout(300);
	await page.keyboard.press("Space");
	await expect(page.getByRole("button", { name: "Use this take" })).toBeVisible();
	await expect(page.locator("body")).toHaveJSProperty(
		"scrollWidth",
		await page.evaluate(() => window.innerWidth),
	);
	const result = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
		.analyze();
	expect(result.violations).toEqual([]);
	await page.emulateMedia({ colorScheme: "dark" });
	expect(
		(await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
			.violations,
	).toEqual([]);
	await shot(page, info, "11-dark");
});
test("admin boundary, curation, metadata persistence and ZIP export", async ({
	page,
	context,
	request,
}, info) => {
	expect((await request.get("/api/admin/export")).status()).toBe(403);
	expect((await request.get("/admin")).status()).toBe(403);
	const token = await new SignJWT({ sub: "test-parker", name: "Test Parker", admin: true })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuer("hey-janet")
		.setAudience("hey-janet")
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(new TextEncoder().encode("browser-test-secret-isolated-not-for-production-1234567890"));
	await context.addCookies([
		{
			name: "booth-auth",
			value: token,
			url: "http://127.0.0.1:18806",
			httpOnly: true,
			sameSite: "Lax",
		},
	]);
	await page.goto("/admin");
	await page.getByRole("button", { name: /Select visible/ }).click();
	await page.getByRole("button", { name: "Keep selected", exact: true }).click();
	await expect(page.getByText("Review saved. Audio is preserved.")).toBeVisible();
	await page.getByLabel("Review", { exact: true }).selectOption("keep");
	await expect(page.locator("audio").first()).toBeVisible();
	await shot(page, info, "12-curation");
	const download = page.waitForEvent("download");
	await page.getByRole("link", { name: "Export kept set" }).click();
	const zip = await download;
	await zip.saveAs(".cache/browser-results/kept.zip");
	await page.getByRole("button", { name: "Drop", exact: true }).first().click();
	await page.getByLabel("Review", { exact: true }).selectOption("drop");
	await expect(page.locator("audio").first()).toBeVisible();
	expect(
		(await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
			.violations,
	).toEqual([]);
});

test("silent input auto-stops with a quiet warning", async ({ page }, info) => {
	await begin(page);
	await page.evaluate(() => {
		Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
			configurable: true,
			value: () => {
				const c = new AudioContext();
				const o = c.createOscillator(),
					g = c.createGain(),
					d = c.createMediaStreamDestination();
				g.gain.value = 0;
				o.connect(g).connect(d);
				o.start();
				void c.resume();
				return Promise.resolve(d.stream);
			},
		});
	});
	await page.getByRole("button", { name: "Record", exact: true }).click();
	await expect(page.getByRole("button", { name: "Use this take" })).toBeVisible({ timeout: 12000 });
	await expect(page.getByText(/This take is very quiet/)).toBeVisible();
	await shot(page, info, "13-quiet-auto-stop");
});

test("clipped input offers a redo warning", async ({ page }, info) => {
	await begin(page);
	await page.evaluate(() => {
		Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
			configurable: true,
			value: () => {
				const c = new AudioContext();
				const o = c.createOscillator(),
					d = c.createMediaStreamDestination();
				o.type = "square";
				const gain = c.createGain();
				gain.gain.value = 3;
				o.connect(gain).connect(d);
				o.start();
				void c.resume();
				return Promise.resolve(d.stream);
			},
		});
	});
	await take(page);
	await expect(page.getByText(/This take may be distorted/)).toBeVisible();
	await shot(page, info, "14-clipped");
});
