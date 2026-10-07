import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { SignJWT } from "jose";
async function begin(page: Page, mode = "wake", name = "Test Voice") {
	await page.goto("/");
	if (page.context().browser()?.browserType().name() === "webkit") await fakeWebkit(page);
	await page.getByLabel("Recording set").selectOption(mode);
	await page.getByLabel("Your first name").fill(name);
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
async function curator(context: BrowserContext) {
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
}
async function take(page: Page) {
	await page.getByRole("button", { name: "Record", exact: true }).click();
	await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
	await page.waitForTimeout(400);
	await page.getByRole("button", { name: "Stop recording" }).click();
	await expect(page.getByRole("button", { name: "Use this take" })).toBeVisible();
}
test("full 40 phrase session, playback and more sets", async ({ page }) => {
	test.setTimeout(90000);
	await page.goto("/");

	await begin(page);

	async function step(i: number): Promise<void> {
		if (i >= 40) return;
		await page.getByRole("button", { name: "Record", exact: true }).click();
		await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();

		await page.waitForTimeout(260);
		await page.getByRole("button", { name: "Stop recording" }).click();
		await expect(page.getByRole("button", { name: "Use this take" })).toBeVisible();
		if (i === 0) {
			await page.locator("audio").evaluate(async (a: HTMLAudioElement) => {
				await a.play();
			});
		}

		await page.getByRole("button", { name: "Use this take" }).click();
		await step(i + 1);
	}
	await step(0);
	await expect(page.getByRole("heading", { name: /That’s a wrap/ })).toBeVisible();
	await expect(page.getByText("Your takes have uploaded. You can close this page.")).toBeVisible({
		timeout: 30000,
	});

	await page.getByRole("button", { name: "Record another set" }).click();
	await expect(page.getByText("Phrase 1 of 40")).toBeVisible();
	async function skipSet(left: number): Promise<void> {
		if (!left) return;
		await page.getByRole("button", { name: "Skip this phrase" }).click();
		await skipSet(left - 1);
	}
	await skipSet(40);
	await page.getByRole("button", { name: "Add a voice profile" }).click();
	await expect(page.getByText("Sentence 1 of 10")).toBeVisible();
	await page.getByRole("button", { name: "Finish voice profile" }).click();
	await expect(page.getByText("0 takes accepted. 12 skipped.")).toBeVisible();
	await page.getByRole("button", { name: "Record a wake-word set" }).click();
	await expect(page.getByText("Phrase 1 of 40")).toBeVisible();
});
test("redo, skip, offline upload recovery and reload keep the session", async ({
	page,
	context,
}) => {
	await begin(page);
	await take(page);
	await page.getByRole("button", { name: "Redo", exact: true }).click();
	await expect(page.getByText("Phrase 1 of 40")).toBeVisible();
	await take(page);
	await page.route("**/api/clips?**", (route) => route.abort("internetdisconnected"));
	await page.getByRole("button", { name: "Use this take" }).click();
	await expect(page.getByRole("status").filter({ hasText: "saved on this device" })).toBeVisible();

	await page.reload();
	await expect(page.getByRole("checkbox")).not.toBeChecked();
	await page.getByRole("checkbox").check();
	await page.getByRole("button", { name: "Resume recording" }).click();
	await expect(page.getByText("Phrase 2 of 40")).toBeVisible();
	await expect(page.getByRole("status").filter({ hasText: "saved on this device" })).toBeVisible();

	await page.unroute("**/api/clips?**");
	await context.setOffline(true);
	await context.setOffline(false);
	await expect(page.getByText("All accepted takes uploaded")).toBeVisible({ timeout: 15000 });
	await page.getByRole("button", { name: "Skip this phrase" }).click();
	await expect(page.getByText("Phrase 3 of 40")).toBeVisible();
	if (page.context().browser()?.browserType().name() === "webkit") await fakeWebkit(page);
	await take(page);
	await page.route("**/api/clips?**", (route) => route.abort("internetdisconnected"));
	await page.getByRole("button", { name: "Use this take" }).click();
	await expect(page.getByRole("status").filter({ hasText: "saved on this device" })).toBeVisible();
	await page.getByRole("button", { name: "Not Test Voice? Start over" }).click();
	await expect(page.getByLabel("Your first name")).toHaveValue("");
	await expect(page.getByRole("checkbox")).not.toBeChecked();
	await expect(page.getByRole("button", { name: "Start recording" })).toBeDisabled();
	await expect(page.getByText(/saved on this device, waiting to upload/)).toHaveCount(0);
	expect((await context.cookies()).some((cookie) => cookie.name === "booth-participant")).toBe(
		false,
	);
	await page.reload();
	await expect(page.getByLabel("Your first name")).toHaveValue("");
});
test("permission denied has recovery guidance", async ({ page }) => {
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
});
test("landing waits for startup before accepting input", async ({ page }) => {
	const startup = Promise.withResolvers<undefined>();
	await page.route("**/_app/immutable/entry/*.js", async (route) => {
		await startup.promise;
		await route.continue();
	});
	await page.goto("/", { waitUntil: "commit" });
	try {
		await expect(page.getByLabel("Your first name")).toBeDisabled();
		await expect(page.getByRole("checkbox", { name: /wake-word/ })).toBeDisabled();
	} finally {
		startup.resolve(undefined);
	}
	await page.getByLabel("Your first name").fill("Slow connection");
	await page.getByRole("checkbox", { name: /wake-word/ }).check();
	await expect(page.getByRole("button", { name: "Start recording" })).toBeEnabled();
	await expect(page.getByLabel("Your first name")).toHaveValue("Slow connection");
});
test("keyboard, labels, contrast and responsive overflow", async ({ page }) => {
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
});
test("admin boundary, curation, metadata persistence and ZIP export", async ({
	page,
	context,
	request,
}) => {
	expect((await request.get("/api/admin/export")).status()).toBe(403);
	expect((await request.get("/admin")).status()).toBe(403);
	await curator(context);
	const startup = Promise.withResolvers<undefined>();
	await page.route("**/_app/immutable/entry/*.js", async (route) => {
		await startup.promise;
		await route.continue();
	});
	await page.goto("/admin", { waitUntil: "commit" });
	try {
		await expect(page.getByLabel("Participant")).toBeDisabled();
		await expect(page.getByRole("button", { name: /Select visible/ })).toBeDisabled();
	} finally {
		startup.resolve(undefined);
	}
	await page.getByRole("button", { name: /Select visible/ }).click();
	await page.getByRole("button", { name: "Keep selected", exact: true }).click();
	await expect(page.getByText("Review saved. Audio is preserved.")).toBeVisible();
	await page.getByLabel("Review", { exact: true }).selectOption("keep");
	await expect(page.locator("audio").first()).toBeVisible();

	const download = page.waitForEvent("download");
	await page.getByRole("link", { name: "Export wake-word set" }).click();
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

test("silent input auto-stops with a quiet warning", async ({ page }) => {
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
});

test("clipped input offers a redo warning", async ({ page }) => {
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
				const silent = c.createGain();
				silent.gain.value = 0;
				gain.connect(silent).connect(c.destination);
				o.start();
				void c.resume();
				return Promise.resolve(d.stream);
			},
		});
	});
	await page.getByRole("button", { name: "Record", exact: true }).click();
	await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
	await page.waitForTimeout(2000);
	await page.getByRole("button", { name: "Stop recording" }).click();
	await expect(page.getByText(/This take may be distorted/)).toBeVisible();
});

function archiveFiles(bytes: Buffer) {
	const files = new Map<string, Buffer>();
	let offset = 0;
	while (bytes.readUInt32LE(offset) === 0x04034b50) {
		expect(bytes.readUInt16LE(offset + 8)).toBe(0);
		const size = bytes.readUInt32LE(offset + 18);
		const nameLength = bytes.readUInt16LE(offset + 26);
		const extraLength = bytes.readUInt16LE(offset + 28);
		const name = bytes.toString("utf8", offset + 30, offset + 30 + nameLength);
		const start = offset + 30 + nameLength + extraLength;
		files.set(name, bytes.subarray(start, start + size));
		offset = start + size;
	}
	expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
	expect(bytes.readUInt16LE(bytes.length - 12)).toBe(files.size);
	return files;
}

test("standalone voice profile, timed answers, recovery and speaker export", async ({
	page,
	context,
}, info) => {
	test.setTimeout(150000);
	const session = page.waitForResponse("**/api/session");
	await begin(page, "speaker", `Speaker ${info.project.name}`);
	const participant: unknown = await (await session).json();
	if (
		!participant ||
		typeof participant !== "object" ||
		!("id" in participant) ||
		typeof participant.id !== "string"
	)
		throw new Error("Session did not return a participant ID.");
	const { id } = participant;
	await expect(page.getByText("Sentence 1 of 10")).toBeVisible();

	async function sentence(left: number): Promise<void> {
		if (!left) return;
		await take(page);
		await page.getByRole("button", { name: "Use this take" }).click();
		await sentence(left - 1);
	}
	await sentence(10);
	await expect(page.getByText("Free speech 1 of 2")).toBeVisible();
	await take(page);
	await expect(page.getByText(/This take is under 20 seconds/)).toBeVisible();
	await page.getByRole("button", { name: "Redo", exact: true }).click();
	await page.getByRole("button", { name: "Record", exact: true }).click();
	await expect(page.getByRole("timer")).toHaveText(/0:2[1-9] \/ 0:30/, { timeout: 28000 });

	await page.getByRole("button", { name: "Stop recording" }).click();
	await page.route("**/api/clips?**", (route) => route.abort("internetdisconnected"));
	await page.getByRole("button", { name: "Use this take" }).click();
	await expect(page.getByRole("status").filter({ hasText: "saved on this device" })).toBeVisible();
	await page.reload();
	await expect(page.getByText("Free speech 2 of 2")).toBeVisible();
	await page.unroute("**/api/clips?**");
	await page.evaluate(() => window.dispatchEvent(new Event("online")));
	if (info.project.name === "iphone-webkit") await fakeWebkit(page);
	await page.getByRole("button", { name: "Record", exact: true }).click();
	await expect(page.getByRole("button", { name: "Use this take" })).toBeVisible({ timeout: 38000 });
	await expect(page.getByRole("timer")).toHaveText("0:30 / 0:30");
	await page.getByRole("button", { name: "Use this take" }).click();
	await expect(page.getByText("12 takes accepted. 0 skipped.")).toBeVisible();
	await expect(page.getByText("Your takes have uploaded. You can close this page.")).toBeVisible({
		timeout: 15000,
	});

	await curator(context);
	await page.goto("/admin");
	await page.getByLabel("Participant").selectOption(id);
	await page.getByLabel("Kind", { exact: true }).selectOption("enroll");
	await expect(page.locator("audio")).toHaveCount(10);
	await page.getByLabel("Kind", { exact: true }).selectOption("free");
	await expect(page.locator("audio")).toHaveCount(2);
	await page.getByLabel("Kind", { exact: true }).selectOption("all");
	await page.getByRole("button", { name: /Select visible/ }).click();
	await page.getByRole("button", { name: "Keep selected", exact: true }).click();
	await expect(page.getByText("Review saved. Audio is preserved.")).toBeVisible();
	const downloading = page.waitForEvent("download");
	await page.getByRole("link", { name: "Export speaker-ID set" }).click();
	const destination = info.outputPath("speaker.zip");
	await (await downloading).saveAs(destination);
	const files = archiveFiles(await readFile(destination));
	const directory = `${id}_speaker-${info.project.name}/`;
	const own = [...files.keys()].filter((name) => name.startsWith(directory));
	expect(own.filter((name) => name.includes("/enroll_"))).toHaveLength(10);
	for (const [name, bytes] of files) {
		if (!name.endsWith(".wav")) continue;
		expect(name).toMatch(/\/(enroll_\d+_.+|free_\d+)\.wav$/);
		expect(bytes.readUInt32LE(24)).toBe(16000);
		expect(bytes.readUInt16LE(22)).toBe(1);
		expect(bytes.readUInt16LE(34)).toBe(16);
	}
	const first = files.get(`${directory}free_00.wav`);
	const second = files.get(`${directory}free_01.wav`);
	expect(first).toBeDefined();
	expect(second).toBeDefined();
	expect(((first?.length ?? 0) - 44) / 32000).toBeGreaterThanOrEqual(20);
	expect(((second?.length ?? 0) - 44) / 32000).toBeGreaterThanOrEqual(29);
	expect(((second?.length ?? 0) - 44) / 32000).toBeLessThanOrEqual(30);
	const journal = files.get(`${directory}clips.jsonl`);
	expect(journal?.toString().trim().split("\n")).toHaveLength(12);
	const wake = archiveFiles(await (await context.request.get("/api/admin/export")).body());
	expect(
		[...wake.keys()]
			.filter((name) => name.endsWith(".wav"))
			.every((name) => /^(positives|negatives)\//.test(name)),
	).toBe(true);
	expect([...wake.keys()].some((name) => /\/(enroll|free)_/.test(name))).toBe(false);
});
