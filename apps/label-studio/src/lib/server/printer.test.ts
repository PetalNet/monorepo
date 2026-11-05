import { createServer, type Server } from "node:http";

import { tapeGeometry } from "$lib/doc";
import { afterEach, describe, expect, it } from "vitest";

import { createPrinter } from "./printer.ts";
import { listenLocal } from "./testing.ts";

let server: Server | undefined;

afterEach(() => {
	server?.close();
	server = undefined;
});

interface Received {
	method: string;
	url: string;
	contentType: string;
	body: string;
}

async function fakeDaemon(
	status: number,
	reply: unknown,
): Promise<{ url: string; received: Received[] }> {
	const received: Received[] = [];

	server = createServer((request, response) => {
		const chunks: Buffer[] = [];

		request.on("data", (chunk: Buffer) => chunks.push(chunk));

		request.on("end", () => {
			received.push({
				method: request.method ?? "",
				url: request.url ?? "",
				contentType: request.headers["content-type"] ?? "",
				body: Buffer.concat(chunks).toString("latin1"),
			});

			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(reply));
		});
	});

	return { url: await listenLocal(server), received };
}

describe("printer status", () => {
	it("reads a ready printer's tape geometry", async () => {
		const { url } = await fakeDaemon(200, {
			width_mm: 12,
			printable_pins: 70,
			pin_margin: 29,
			phase: 0,
		});

		expect(await createPrinter(url).status()).toEqual({ state: "ready", tape: tapeGeometry(12) });
	});

	it.each([
		["no tape", { state: "error", message: "No tape", tape: null }],
		["cover open", { state: "error", message: "Cover open", tape: null }],
		["wrong tape", { state: "error", message: "Wrong tape", tape: null }],
		["cutter jam", { state: "error", message: "Cutter jam", tape: null }],
		["printer overheated", { state: "error", message: "Printer overheated", tape: null }],
		[
			"Brother PT-P710BT (04f9:20af) not found",
			{ state: "offline", message: "Printer not connected" },
		],
		["something new", { state: "error", message: "Something new", tape: null }],
	])("maps the daemon's 503 %j", async (detail, expected) => {
		const { url } = await fakeDaemon(503, { detail });

		expect(await createPrinter(url).status()).toEqual(expected);
	});

	it("is offline when nothing listens", async () => {
		const { url } = await fakeDaemon(200, {});

		server?.close();

		expect(await createPrinter(url).status()).toEqual({
			state: "offline",
			message: "Print server unreachable",
		});
	});

	it("is offline when the daemon does not answer in time", async () => {
		const neverAnswer = (): void => undefined;

		server = createServer(neverAnswer);
		const url = await listenLocal(server);
		const printer = createPrinter(url, { statusMs: 50, printMs: 50 });

		expect(await printer.status()).toEqual({
			state: "offline",
			message: "Print server unreachable",
		});

		server.closeAllConnections();
	});
});

describe("printer print", () => {
	it("posts every page and option as multipart fields", async () => {
		const { url, received } = await fakeDaemon(200, { ok: true });
		const outcome = await createPrinter(url).print(
			[Uint8Array.of(0x89, 0x50), Uint8Array.of(0x89, 0x51)],
			{
				copies: 2,
				cut: false,
				chain: true,
				expectWidthMm: 12,
			},
		);

		expect(outcome).toEqual({ ok: true });
		const [request] = received;

		expect(request.url).toBe("/api/print/raster");
		expect(request.contentType).toMatch(/^multipart\/form-data; boundary=/);

		const field = (name: string): string | undefined =>
			new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(request.body)?.[1];

		expect(field("copies")).toBe("2");
		expect(field("cut")).toBe("false");
		expect(field("chain")).toBe("true");
		expect(field("expect_width_mm")).toBe("12");
		expect(request.body.match(/name="pages"; filename=/g)).toHaveLength(2);
	});

	it("returns the daemon's refusal as a sentence", async () => {
		const { url } = await fakeDaemon(400, {
			detail: "wrong tape: designed for 24 mm, 12 mm loaded",
		});
		const outcome = await createPrinter(url).print([Uint8Array.of(1)], {
			copies: 1,
			cut: true,
			chain: false,
			expectWidthMm: 24,
		});

		expect(outcome).toEqual({ ok: false, message: "Wrong tape: designed for 24 mm, 12 mm loaded" });
	});
});
