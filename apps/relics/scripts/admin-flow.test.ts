import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { chromium, devices, type Page } from "playwright";

import { installNfcMock } from "./nfc-mock.ts";

const photo = {
	name: "synthetic-pixel.png",
	mimeType: "image/png",
	buffer: Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVN8AAAAASUVORK5CYII=",
		"base64",
	),
};

async function startPreview() {
	const directory = await mkdtemp(path.join(tmpdir(), "relics-admin-e2e-"));
	const socket = createServer();

	socket.listen(0, "127.0.0.1");
	await once(socket, "listening");
	const address = socket.address();

	assert.ok(address && typeof address !== "string");
	const port = address.port;

	await new Promise<void>((resolve) => {
		socket.close(() => {
			resolve();
		});
	});

	const origin = `http://127.0.0.1:${String(port)}`;
	let logs = "";
	const child = spawn(process.execPath, ["build"], {
		cwd: new URL("..", import.meta.url),
		env: {
			...process.env,
			HOST: "127.0.0.1",
			PORT: String(port),
			ORIGIN: origin,
			RELICS_DB: path.join(directory, "test.db"),
			RELICS_UPLOADS: path.join(directory, "uploads"),
			BODY_SIZE_LIMIT: "16M",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	child.stdout.on("data", (data: Buffer) => {
		logs += data.toString();
	});

	child.stderr.on("data", (data: Buffer) => {
		logs += data.toString();
	});

	const stop = async () => {
		if (child.exitCode === null) {
			child.kill();
			await once(child, "exit");
		}

		await rm(directory, { recursive: true, force: true });
	};

	try {
		await mkdir(path.join(directory, "uploads"));

		const waitForHealth = async (remaining: number): Promise<void> => {
			if (child.exitCode !== null) {
				throw new Error(`Preview exited: ${logs}`);
			}

			if (
				await fetch(`${origin}/health`)
					.then((response) => response.ok)
					.catch(() => false)
			) {
				return;
			}

			if (!remaining) {
				throw new Error(`Preview did not start: ${logs}`);
			}

			await delay(50);
			await waitForHealth(remaining - 1);
		};

		await waitForHealth(100);

		assert.equal((await fetch(`${origin}/health`)).status, 200, logs);
		const db = new DatabaseSync(path.join(directory, "test.db"));
		const token = randomBytes(32).toString("base64url");

		db.prepare("INSERT INTO AdminSession VALUES (?,?,?)").run(
			createHash("sha256").update(token).digest("hex"),
			"e2e-staff",
			Date.now() + 3600000,
		);

		// Legacy open ranges supply lore, not a reservation of every future number.
		db.exec(`INSERT INTO RelicType(id,name) VALUES (1,'Legacy');
			INSERT INTO RelicVariety(id,typeId,name) VALUES (1,1,'Original');
			INSERT INTO AllocationRange(typeId,varietyId,lore) VALUES (1,1,'Legacy story');
			INSERT INTO Relic(id,typeId,varietyId,indexNumber,name) VALUES ('legacy-url',1,1,0,'Legacy #0');`);

		return { origin, token, db, stop };
	} catch (error) {
		await stop();

		throw error;
	}
}

const combo = (page: Page, label: string) =>
	page.getByRole("combobox", { name: new RegExp(`^${label}`) });

async function filters(page: Page) {
	const disclosure = page.getByText("Change color or tag batch", { exact: true });

	if ((await disclosure.count()) && !(await combo(page, "Color or design").isVisible())) {
		await disclosure.tap();
	}
}

async function present(page: Page, url = "", serial = "04:AB:CD:01") {
	await page.evaluate(
		(tag) => {
			window.nfcMock.present(tag.url, tag.serial);
		},
		{ url, serial },
	);
}

async function readback(page: Page) {
	return page.evaluate(() => {
		const tag = window.nfcMock.tag;

		if (!tag) {
			throw new Error("No physical mock tag");
		}

		window.nfcMock.remove();
		window.nfcMock.present(tag.url, tag.serial);

		return tag.url;
	});
}

async function startWrite(page: Page, number: number) {
	await page.getByRole("button", { name: `Write tag #${String(number)}`, exact: true }).tap();

	if (await page.evaluate(() => window.nfcMock.permission === "prompt")) {
		await page.waitForFunction(() => window.nfcMock.waitingForPermission);

		await page.evaluate(() => {
			window.nfcMock.allow();
		});
	}

	await page.getByText(`Ready to write #${String(number)}`, { exact: true }).waitFor();
}

async function writeTag(page: Page, number: number, slow = false) {
	await startWrite(page, number);

	if (slow) {
		await page.waitForTimeout(3000);
	}

	await present(page, "", `04:AB:${String(number)}`);
	await page.getByText(/Checking the URL/).waitFor();

	if (slow) {
		await page.waitForTimeout(5000);
	}

	const url = await readback(page);

	await page
		.getByText(`Tag written! #${String(number)} is checked and saved.`, { exact: false })
		.waitFor();

	await page.evaluate(() => {
		window.nfcMock.reread();
		window.nfcMock.reread();
		window.nfcMock.remove();
	});

	return url;
}

function inOrder<T>(items: readonly T[], visit: (item: T) => Promise<void>) {
	return items.reduce((previous, item) => previous.then(() => visit(item)), Promise.resolve());
}

[
	{ width: 360, height: 780 },
	{ width: 412, height: 915 },
].forEach(({ width, height }) => {
	void test(
		`maker setup, ordered NFC writes and recovery at ${String(width)}×${String(height)}`,
		{ timeout: 180000 },
		async (t) => {
			const preview = await startPreview();

			t.after(async () => {
				preview.db.close();
				await preview.stop();
			});

			const browser = await chromium.launch({
				executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
			});

			t.after(() => browser.close());

			const context = await browser.newContext({
				...devices["Pixel 7"],
				viewport: { width, height },
				deviceScaleFactor: 2,
			});

			await context.addInitScript(installNfcMock);
			const page = await context.newPage();

			page.setDefaultTimeout(10000);
			const errors: string[] = [];

			page.on("pageerror", (error) => errors.push(error.message));
			assert.equal((await page.goto(`${preview.origin}/admin`))?.status(), 401);
			await page.getByRole("link", { name: "Admin sign-in", exact: true }).tap();
			await page.getByRole("link", { name: "Sign in with Authentik", exact: true }).waitFor();

			// OIDC signature/PKCE/group behavior has separate tests; this browser fixture starts a staff session.
			await context.addCookies([
				{ name: "relics_admin", value: preview.token, url: preview.origin, httpOnly: true },
			]);

			await page.goto(`${preview.origin}/admin`);
			assert.ok(await page.evaluate(() => matchMedia("(pointer: coarse)").matches));
			await page.getByRole("button", { name: "Add a new relic type", exact: true }).tap();
			await page.getByLabel("Type name", { exact: true }).fill("Snail");
			await page.getByText("Description and type photo (optional)", { exact: true }).tap();
			await page.locator("input[type=file]").setInputFiles(photo);
			await page.getByAltText("Photo preview", { exact: true }).waitFor();
			await context.setOffline(true);
			await page.getByRole("button", { name: "Save and add colors", exact: true }).tap();
			await page.getByRole("alert").filter({ hasText: "Check your internet connection" }).waitFor();
			assert.equal(await page.getByLabel("Type name", { exact: true }).inputValue(), "Snail");
			await context.setOffline(false);
			await page.getByRole("button", { name: "Save and add colors", exact: true }).tap();
			await page.getByRole("heading", { name: "Add a color or design", exact: true }).waitFor();
			const typeId = await combo(page, "Relic type").inputValue();

			await inOrder(["Moss green", "Rose pink", "Sky blue"], async (color) => {
				await page.getByLabel("Color or design name", { exact: true }).fill(color);
				await page.locator("input[type=file]").setInputFiles(photo);
				await page.getByAltText("Photo preview", { exact: true }).waitFor();
				await page.getByRole("button", { name: "Save color or design", exact: true }).tap();
				await page.getByRole("heading", { name: "Saved for Snail", exact: true }).waitFor();

				await page.waitForFunction(
					() =>
						document.querySelector<HTMLInputElement>('input[placeholder="For example, Moss green"]')
							?.value === "",
				);
			});

			await page.getByRole("button", { name: "Continue to make tags", exact: true }).tap();
			const varieties: string[] = [];
			let visitorUrl = "";

			await inOrder([0, 1, 2], async (color) => {
				if (color) {
					await page.getByRole("link", { name: "Make more tags", exact: true }).tap();
					assert.ok((await combo(page, "Relic type").inputValue()) === typeId);
				}

				await combo(page, "Color or design").selectOption({ index: color });
				const variety = await combo(page, "Color or design").inputValue();

				varieties.push(variety);
				await page.getByLabel("How many tags?", { exact: true }).fill("5");
				await page.getByRole("button", { name: "Make tags and start writing", exact: true }).tap();
				await page.waitForURL(/nfc-writer/);

				await inOrder([0, 1, 2, 3, 4], async (number) => {
					if (color === 0 && number === 0) {
						await page.getByRole("button", { name: "Write tag #0", exact: true }).tap();
						await page.waitForFunction(() => window.nfcMock.waitingForPermission);

						await page.evaluate(() => {
							window.nfcMock.allow(false);
						});

						await page
							.getByRole("alert")
							.filter({ hasText: "NFC permission was blocked" })
							.waitFor();

						assert.equal(await page.evaluate(() => window.nfcMock.writes.length), 0);

						await page.evaluate(() => {
							window.nfcMock.allow();
						});
					}

					visitorUrl = await writeTag(
						page,
						number,
						process.env.RELICS_QA_SLOW === "1" || (color === 0 && number === 0),
					);

					if (color === 0 && number === 0) {
						await page.evaluate(() => {
							window.nfcMock.allow(false);
						});

						await page.getByRole("button", { name: "Write tag #1", exact: true }).tap();

						const failure = page
							.getByRole("alert")
							.filter({ hasText: "NFC permission was blocked" });

						await failure.waitFor();
						assert.equal(await page.getByText("Saved.", { exact: true }).count(), 0);
						const failureBox = await failure.boundingBox();
						const writeBox = await page
							.getByRole("button", { name: "Write tag #1", exact: true })
							.boundingBox();

						assert.ok(failureBox && writeBox && failureBox.y < writeBox.y);

						await page.evaluate(() => {
							window.nfcMock.allow();
						});
					}

					if (color === 0 && number === 1) {
						await combo(page, "Workshop tool").selectOption("");

						await page
							.getByRole("link", { name: "Pick up where you left off: write tags", exact: true })
							.tap();

						await page.getByRole("button", { name: "Write tag #2", exact: true }).waitFor();
						await filters(page);
						assert.ok((await combo(page, "Color or design").inputValue()) === variety);
						await page.reload();
						await page.getByRole("button", { name: "Write tag #2", exact: true }).waitFor();
					}
				});

				await page.getByRole("heading", { name: "All 5 tags are written", exact: true }).waitFor();
				await page.reload();
				await page.getByRole("heading", { name: "All 5 tags are written", exact: true }).waitFor();
				assert.equal(await page.getByRole("button", { name: /^Write tag/ }).count(), 0);
			});

			const lastVariety = varieties.at(-1);

			assert.ok(lastVariety);
			await page.getByRole("link", { name: "Make more tags", exact: true }).tap();
			assert.ok((await combo(page, "Color or design").inputValue()) === lastVariety);
			await page.getByLabel("How many tags?", { exact: true }).fill("3");
			await page.getByRole("button", { name: "Make tags and start writing", exact: true }).tap();
			await page.waitForURL(/nfc-writer/);
			await startWrite(page, 5);
			await present(page, "https://relics.petalcat.dev/relics/other", "foreign");
			await page.getByText("This tag belongs to a different relic.", { exact: true }).waitFor();
			const cancel = page.getByRole("button", { name: "Cancel", exact: true });
			const box = await cancel.boundingBox();

			assert.ok(
				box && box.y >= 0 && box.y + box.height <= height,
				"replacement Cancel is visible without scrolling",
			);

			const writesBefore = await page.evaluate(() => window.nfcMock.writes.length);

			await cancel.tap();
			assert.ok((await page.evaluate(() => window.nfcMock.writes.length)) === writesBefore);
			await startWrite(page, 5);
			await present(page, "https://relics.petalcat.dev/relics/other", "foreign");
			await page.getByRole("button", { name: "Replace with tag #5", exact: true }).tap();
			await page.getByText(/Lift the tag away, then tap the same tag again to confirm/).waitFor();

			await page.evaluate(() => {
				window.nfcMock.remove();
			});

			await present(page, "https://relics.petalcat.dev/relics/other", "foreign");
			await page.getByText(/Checking the URL/).waitFor();
			await readback(page);
			await page.getByText("Tag written! #5 is checked and saved.", { exact: false }).waitFor();
			await startWrite(page, 6);

			await page.evaluate(() => {
				window.nfcMock.failNext("NotSupportedError");
			});

			await present(page, "", "locked");

			await page
				.getByRole("alert")
				.filter({ hasText: /locked|incompatible/ })
				.waitFor();

			await startWrite(page, 6);
			await page.setViewportSize({ width: height, height: width });
			await page.getByText("Ready to write #6", { exact: true }).waitFor();
			await page.setViewportSize({ width, height });
			await present(page, "", "network");
			await page.getByText(/Checking the URL/).waitFor();
			await context.setOffline(true);
			const writtenUrl = await readback(page);

			await page.getByRole("button", { name: "Save checklist again", exact: true }).waitFor();
			const writesAtFailure = await page.evaluate(() => window.nfcMock.writes.length);

			await page.evaluate(() => {
				window.nfcMock.reread();
			});

			await page.getByRole("button", { name: "Save checklist again", exact: true }).waitFor();
			await context.setOffline(false);
			await page.getByRole("button", { name: "Save checklist again", exact: true }).tap();
			await page.getByRole("button", { name: "Write tag #7", exact: true }).waitFor();

			assert.ok(
				(await page.evaluate(() => window.nfcMock.writes.length)) === writesAtFailure,
				"retry saves without rewriting NFC",
			);

			await page.reload();
			await page.getByText("2 of 3 written", { exact: false }).waitFor();
			await startWrite(page, 7);
			await present(page, "", "cancel-after-write");
			await page.getByText(/Checking the URL/).waitFor();
			await page.getByRole("button", { name: "Cancel", exact: true }).tap();
			await page.getByRole("alert").filter({ hasText: "Cancelled." }).waitFor();
			await page.getByText("2 of 3 written", { exact: false }).waitFor();
			await combo(page, "Workshop tool").selectOption("");

			const row = page
				.locator(".type-row")
				.filter({ has: page.getByRole("heading", { name: "Snail", exact: true }) });

			await row.getByRole("button", { name: "Add a color or design", exact: true }).tap();
			await page.getByLabel("Color or design name", { exact: true }).fill("Gold");
			await page.locator("input[type=file]").setInputFiles(photo);
			await page.getByAltText("Photo preview", { exact: true }).waitFor();
			await page.getByRole("button", { name: "Save color or design", exact: true }).tap();
			await page.getByRole("heading", { name: "Saved for Snail", exact: true }).waitFor();
			await page.getByRole("button", { name: "Continue to make tags", exact: true }).tap();
			await page.getByLabel("How many tags?", { exact: true }).fill("1");
			await page.getByRole("button", { name: "Make tags and start writing", exact: true }).tap();
			await page.waitForURL(/nfc-writer/);
			await writeTag(page, 0);
			await combo(page, "Workshop tool").selectOption("catalog");

			const form = page
				.locator("form")
				.filter({ has: page.getByRole("heading", { name: "Varieties", exact: true }) });

			await form.getByRole("combobox", { name: /^Edit or create/ }).selectOption(lastVariety);
			await form.locator("input[type=file]").setInputFiles({ ...photo, name: "changed-pixel.png" });
			await form.getByAltText("Photo preview", { exact: true }).waitFor();
			await form.getByRole("button", { name: "Save variety", exact: true }).tap();
			await page.getByText("Saved.", { exact: true }).waitFor();

			const changedPhoto = await form
				.getByAltText("Photo preview", { exact: true })
				.getAttribute("src");
			const guest = await browser.newContext({
				...devices["Pixel 7"],
				viewport: { width, height },
			});
			const visitor = await guest.newPage();

			await visitor.goto(writtenUrl);
			await visitor.getByRole("button", { name: "Name me!", exact: true }).tap();
			await visitor.getByLabel("Friend's name", { exact: true }).fill("Moss");
			await visitor.getByLabel("Your first name", { exact: true }).fill("Preview");
			await visitor.getByRole("button", { name: "That's my name!", exact: true }).tap();
			await visitor.getByRole("heading", { name: /Hi, I'm.*Moss!/ }).waitFor();
			await visitor.reload();
			await visitor.getByRole("heading", { name: /Hi, I'm.*Moss!/ }).waitFor();

			assert.ok(
				(await visitor.getByAltText("Sky blue Snail", { exact: true }).getAttribute("src")) ===
					changedPhoto,
			);

			assert.ok(visitorUrl.startsWith(`${preview.origin}/relics/`));
			assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
			assert.deepEqual(errors, []);
			// Reproduce the allocation blocker with a legacy open lore range and a real existing URL.
			await page.goto(`${preview.origin}/admin/allocate?type=1&variety=1`);
			await page.getByLabel("How many tags?", { exact: true }).fill("2");
			await page.getByRole("button", { name: "Make tags and start writing", exact: true }).tap();
			await page.waitForURL(/nfc-writer/);
			await page.getByRole("button", { name: "Write tag #1", exact: true }).waitFor();

			assert.equal(
				(await context.request.get(`${preview.origin}/relics/legacy-url`)).status(),
				200,
			);

			assert.equal(
				preview.db.prepare("SELECT count(*) n FROM Relic WHERE varietyId=1").get()?.n,
				3,
			);

			await combo(page, "Workshop tool").selectOption("allocate");
			await combo(page, "Relic type").selectOption("1");
			await page.getByLabel("How many tags?", { exact: true }).fill("1");

			// A second maker takes the suggested next number after this page loaded.
			preview.db.exec(
				"INSERT INTO AllocationRange(typeId,varietyId,startIndex,endIndex) VALUES (1,1,3,3)",
			);

			await page.getByRole("button", { name: "Make tags and start writing", exact: true }).tap();
			await page.getByRole("button", { name: "Use next free numbers", exact: true }).tap();
			await page.waitForURL(/nfc-writer/);
			await page.getByRole("button", { name: "Write tag #4", exact: true }).waitFor();
			await context.close();
			await guest.close();
		},
	);
});
