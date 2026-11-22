import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createTagScanner,
	idleTagMessage,
	nfcError,
	supportsNfc,
	writeVerifiedTag,
} from "./web-nfc";

class Reader {
	onreading:
		| ((event: {
				serialNumber: string;
				message: { records: { recordType: string; data?: DataView }[] };
		  }) => void)
		| null = null;
	onreadingerror: (() => void) | null = null;
	scan = vi.fn((_options: { signal: AbortSignal }) => Promise.resolve());
	write = vi.fn(() => Promise.resolve());
	read(url?: string, serialNumber = "tag-A") {
		this.onreading?.({
			serialNumber,
			message: {
				records:
					url === undefined
						? [{ recordType: "empty" }]
						: [{ recordType: "url", data: new DataView(new TextEncoder().encode(url).buffer) }],
			},
		});
	}
}
const url = "https://relics.petalcat.dev/relics/EXACT";

function setup() {
	const reader = new Reader();

	function FakeNDEFReader() {
		return reader;
	}

	vi.stubGlobal("window", { isSecureContext: true, NDEFReader: vi.fn(FakeNDEFReader) });

	const controller = new AbortController();
	const states: string[] = [];
	const confirm = vi.fn(() => Promise.resolve());
	const run = () =>
		writeVerifiedTag({
			url,
			signal: controller.signal,
			onState: (state) => states.push(state.kind),
			confirmOverwrite: confirm,
		});

	return { reader, controller, states, confirm, run };
}

async function until(predicate: () => boolean) {
	await vi.waitFor(() => {
		expect(predicate()).toBe(true);
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("browser NFC writing", () => {
	it("requires a secure context and an NFC implementation", () => {
		vi.stubGlobal("window", { isSecureContext: true });
		expect(supportsNfc()).toBe(false);
		setup();
		expect(supportsNfc()).toBe(true);
		vi.stubGlobal("window", { isSecureContext: false, NDEFReader: Reader });
		expect(supportsNfc()).toBe(false);
	});

	it("writes a URL without overwrite and requires a fresh read after writing", async () => {
		const { reader, run, states } = setup();
		const pending = run();

		await until(() => states.includes("waiting"));
		reader.read();
		await until(() => states.includes("verifying"));

		expect(reader.write).toHaveBeenCalledWith(
			{ records: [{ recordType: "url", data: url }] },
			expect.objectContaining({ overwrite: false }),
		);

		reader.read(url);
		await pending;
		expect(reader.onreading).toBeNull();
		expect(reader.onreadingerror).toBeNull();
	});

	it("asks before replacing existing data", async () => {
		const { reader, run, states, confirm } = setup();
		let approve: (() => void) | undefined;

		confirm.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					approve = resolve;
				}),
		);

		const pending = run();

		await until(() => states.includes("waiting"));
		reader.read("https://relics.petalcat.dev/relics/OTHER");
		await until(() => states.includes("overwrite"));
		expect(reader.write).not.toHaveBeenCalled();
		approve?.();
		await until(() => states.includes("confirming"));
		reader.read("https://relics.petalcat.dev/relics/OTHER");
		await until(() => states.includes("verifying"));

		expect(reader.write).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ overwrite: true }),
		);

		reader.read(url);
		await pending;
	});

	it.each(["tag-B", "tag-A"])(
		"invalidates replacement consent when %s changes identity or contents",
		async (serial) => {
			const { reader, run, states, confirm } = setup();
			const permission = Promise.withResolvers<undefined>();

			confirm.mockReturnValue(permission.promise);
			const pending = run();
			const result = expect(pending).rejects.toThrow("tag or its contents changed");

			await until(() => states.includes("waiting"));
			reader.read("https://example.com/original");
			await until(() => states.includes("overwrite"));
			reader.read("https://example.com/changed", serial);
			await result;
			permission.resolve(undefined);
			expect(reader.write).not.toHaveBeenCalled();
		},
	);

	it("refuses replacement when a tag has no serial number", async () => {
		const { reader, run, states, confirm } = setup();
		const pending = run();
		const result = expect(pending).rejects.toThrow("cannot identify this tag safely");

		await until(() => states.includes("waiting"));
		reader.read("https://example.com/original", "");
		await result;
		expect(confirm).not.toHaveBeenCalled();
		expect(reader.write).not.toHaveBeenCalled();
	});

	it.each(["https://example.com/wrong", "https://relics.petalcat.dev/relics/EXACT/"])(
		"rejects a readback of %s",
		async (readback) => {
			const { reader, run, states } = setup();
			const pending = run();
			const result = expect(pending).rejects.toThrow("does not exactly match");

			await until(() => states.includes("waiting"));
			reader.read();
			await until(() => states.includes("verifying"));
			reader.read(readback);
			await result;
		},
	);

	it("rejects a different physical tag even when the URL matches", async () => {
		const { reader, run, states } = setup();
		const pending = run();
		const result = expect(pending).rejects.toThrow("different physical tag");

		await until(() => states.includes("waiting"));
		reader.read();
		await until(() => states.includes("verifying"));
		reader.read(url, "tag-B");
		await result;
	});

	it("aborts while permission is pending without writing", async () => {
		const { reader, controller, run } = setup();
		const permission = Promise.withResolvers<undefined>();

		reader.scan.mockReturnValue(permission.promise);
		const pending = run();
		const result = expect(pending).rejects.toMatchObject({ name: "AbortError" });

		controller.abort(new DOMException("Cancelled", "AbortError"));
		await result;
		expect(reader.write).not.toHaveBeenCalled();
		expect(reader.onreading).toBeNull();
	});

	it("propagates permission failure and cleans listeners", async () => {
		const { reader, run } = setup();

		reader.scan.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
		await expect(run()).rejects.toMatchObject({ name: "NotAllowedError" });
		expect(reader.write).not.toHaveBeenCalled();
		expect(reader.onreading).toBeNull();
	});

	it("reports NFC settings, permission and connection recovery", () => {
		expect(nfcError(new DOMException("", "NotReadableError"), false)).toContain("Turn on NFC");
		expect(nfcError(new DOMException("", "NotAllowedError"), false)).toContain("site settings");
		expect(nfcError(new DOMException("", "NetworkError"), true)).toContain("Hold one tag still");
	});
});

describe("foreground NFC scan", () => {
	it("shows the same tag again after a new write session starts", async () => {
		const { reader } = setup();
		const onRead = vi.fn();
		const scanner = createTagScanner(onRead, vi.fn());

		await scanner.start();
		reader.read(url);
		reader.read(url);
		expect(onRead).toHaveBeenCalledTimes(1);
		await scanner.start();
		reader.read(url);
		expect(onRead).toHaveBeenCalledTimes(2);
		expect(reader.scan).toHaveBeenCalledTimes(1);
		scanner.stop();
	});

	it("keeps receiving a lingering verified tag without writing or marking twice", async () => {
		const { reader } = setup();
		const messages: string[] = [];
		const saved = vi.fn();
		const states: string[] = [];
		const scanner = createTagScanner(
			(event) => messages.push(idleTagMessage(event, 22, [{ url, number: 21 }])),
			vi.fn(),
		);

		await scanner.start();

		const pending = writeVerifiedTag({
			url,
			reader: scanner.reader,
			signal: new AbortController().signal,
			onState: (state) => states.push(state.kind),
			confirmOverwrite: () => Promise.resolve(),
		}).then(saved);

		await until(() => states.includes("waiting"));
		reader.read();
		await until(() => states.includes("verifying"));
		reader.read(url);
		await pending;
		reader.read(url);
		reader.read(url);
		expect(messages).toEqual(["Already written ✓ #21. You can move it away."]);
		expect(saved).toHaveBeenCalledTimes(1);
		expect(reader.write).toHaveBeenCalledTimes(1);
		expect(reader.scan).toHaveBeenCalledTimes(1);
		scanner.stop();
	});

	it("reports blank and foreign tags between writes without writing", async () => {
		const { reader } = setup();
		const messages: string[] = [];
		const scanner = createTagScanner(
			(event) => messages.push(idleTagMessage(event, 22, [])),
			vi.fn(),
		);

		await scanner.start();
		reader.read();
		reader.read("https://relics.petalcat.dev/relics/OTHER", "tag-B");
		expect(messages[0]).toBe("Blank tag. Tap Write to use it for #22.");
		expect(messages[1]).toContain("https://relics.petalcat.dev/relics/OTHER");
		expect(reader.write).not.toHaveBeenCalled();
		scanner.stop();
	});

	it("releases and reacquires scanning on foreground changes", async () => {
		const { reader } = setup();
		const onRead = vi.fn();
		const scanner = createTagScanner(onRead, vi.fn());

		await scanner.start();
		const signal = reader.scan.mock.calls[0]?.[0]?.signal;

		scanner.stop();
		expect(signal.aborted).toBe(true);
		reader.read();
		expect(onRead).not.toHaveBeenCalled();
		await scanner.start();
		reader.read();
		expect(onRead).toHaveBeenCalledTimes(1);
		expect(reader.scan).toHaveBeenCalledTimes(2);
		scanner.stop();
	});
});
