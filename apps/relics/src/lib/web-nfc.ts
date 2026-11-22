interface NfcRecord {
	recordType: string;
	data?: DataView;
}
interface NfcReading {
	serialNumber: string;
	message: { records: readonly NfcRecord[] };
}
interface NfcReader {
	onreading: ((event: NfcReading) => void) | null;
	onreadingerror: (() => void) | null;
	scan: (options: { signal: AbortSignal }) => Promise<void>;
	write: (
		message: { records: { recordType: "url"; data: string }[] },
		options: { signal: AbortSignal; overwrite: boolean },
	) => Promise<void>;
}
declare global {
	interface Window {
		NDEFReader?: new () => NfcReader;
	}
}

export type NfcState =
	| { kind: "permission" }
	| { kind: "waiting" }
	| { kind: "overwrite"; existing: string; differentRelic: boolean }
	| { kind: "confirming" }
	| { kind: "writing" }
	| { kind: "verifying" };

export function supportsNfc() {
	return typeof window !== "undefined" && window.isSecureContext && Boolean(window.NDEFReader);
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			const reason: unknown = signal.reason;

			reject(reason instanceof Error ? reason : new DOMException("Cancelled", "AbortError"));
		};

		signal.addEventListener("abort", abort, { once: true });

		if (signal.aborted) {
			abort();
		}

		void pending.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", abort);
		});
	});
}

export function nfcError(error: unknown, writing: boolean): string {
	const name = error instanceof Error ? error.name : "";

	switch (name) {
		case "NotAllowedError":
		case "SecurityError":
			return writing
				? "Writing was blocked. Check Chrome’s NFC permission. The tag may also be locked; try a blank tag."
				: "NFC permission was blocked. In Chrome’s site settings, allow NFC, then try again.";
		case "NotSupportedError":
			return writing
				? "This tag may be locked or incompatible. Try a writable NDEF tag."
				: "NFC is unavailable. Use Chrome on an Android phone with NFC.";
		case "NotReadableError":
			return "NFC could not start. Turn on NFC in Android settings and keep this page open.";
		case "NetworkError":
			return "The tag connection was lost. Hold one tag still against the back of your phone and try again.";
		case "TimeoutError":
			return "No verified tag before the time ran out. Check NFC is on, then try again and hold the tag still.";
		case "AbortError":
			return "Cancelled. The checklist was not saved. If writing had started, scan the tag again to check it.";
		default:
			return error instanceof Error && error.message.startsWith("Tag check:")
				? error.message.slice(11)
				: "The tag could not be written and verified. It may be full, locked, or incompatible. Try a blank writable NDEF tag with enough space for this URL.";
	}
}

export function idleTagMessage(
	event: NfcReading,
	next: number,
	written: readonly { url: string; number: number }[],
) {
	const urls = event.message.records
		.filter((record) => record.recordType === "url")
		.map((record) => (record.data ? new TextDecoder().decode(record.data) : "Unreadable URL"));
	const known = written.find((tag) => urls.includes(tag.url));

	if (known) {
		return `Already written ✓ #${String(known.number)}. You can move it away.`;
	}

	if (event.message.records.every((record) => record.recordType === "empty")) {
		return `Blank tag. Tap Write to use it for #${String(next)}.`;
	}

	return `This tag contains ${urls.join(", ") || "other data"}. Tap Write only if you want to replace it.`;
}

// The foreground scan owns NFC access; write sessions only borrow its event stream.
export function createTagScanner(onRead: (event: NfcReading) => void, onError: () => void) {
	const Reader = window.NDEFReader;

	if (!Reader) {
		throw new DOMException("NFC unavailable", "NotSupportedError");
	}

	const physical = new Reader();
	let scan: { controller: AbortController; ready: Promise<void> } | undefined;
	let last: { key: string; at: number } | undefined;
	const reader: NfcReader = {
		onreading: null,
		onreadingerror: null,
		scan: () => start(),
		write: (message, options) => physical.write(message, options),
	};

	physical.onreading = (event) => {
		if (!scan || scan.controller.signal.aborted) {
			return;
		}

		if (reader.onreading) {
			reader.onreading(event);

			return;
		}

		const key = JSON.stringify([
			event.serialNumber,
			event.message.records.map((record) => [
				record.recordType,
				record.data ? new TextDecoder().decode(record.data) : "",
			]),
		]);
		const now = Date.now();

		if (last?.key === key && now - last.at < 3000) {
			return;
		}

		last = { key, at: now };
		onRead(event);
	};

	physical.onreadingerror = () => {
		if (reader.onreadingerror) {
			reader.onreadingerror();
		} else {
			onError();
		}
	};

	function start() {
		last = undefined;

		if (scan) {
			return scan.ready;
		}

		const controller = new AbortController();
		const ready = physical.scan({ signal: controller.signal });
		const current = { controller, ready };

		scan = current;

		void ready.catch(() => {
			if (scan === current) {
				controller.abort();
				scan = undefined;
			}
		});

		return ready;
	}

	function stop() {
		scan?.controller.abort();
		scan = undefined;
		last = undefined;
	}

	return { reader, start, stop };
}

export async function writeVerifiedTag({
	url,
	signal,
	onState,
	confirmOverwrite,
	reader: sharedReader,
}: {
	url: string;
	reader?: NfcReader;
	signal: AbortSignal;
	onState: (state: NfcState) => void;
	confirmOverwrite: () => Promise<void>;
}) {
	const Reader = window.NDEFReader;

	const reader = sharedReader ?? (Reader ? new Reader() : undefined);

	if (!reader) {
		throw new DOMException("NFC unavailable", "NotSupportedError");
	}

	const tagGuard = new AbortController();
	const sessionSignal = AbortSignal.any([signal, tagGuard.signal]);
	let protectedSerial: string | undefined;
	let receive: ((event: NfcReading) => void) | undefined;
	let latestReading: NfcReading | undefined;
	let protectedContents: string | undefined;

	function contents(event: NfcReading) {
		return JSON.stringify(
			event.message.records.map((record) => [
				record.recordType,
				record.data
					? Array.from(
							new Uint8Array(record.data.buffer, record.data.byteOffset, record.data.byteLength),
						)
					: [],
			]),
		);
	}

	function guardTag(event: NfcReading) {
		if (
			protectedSerial !== undefined &&
			(event.serialNumber !== protectedSerial ||
				(protectedContents !== undefined && contents(event) !== protectedContents))
		) {
			tagGuard.abort(
				new Error(
					"Tag check: The tag or its contents changed. Nothing else will be written. Start again and check the tag before replacing it.",
				),
			);
		}
	}

	function nextReading() {
		return abortable(
			new Promise<NfcReading>((resolve) => {
				receive = resolve;
			}),
			sessionSignal,
		);
	}

	reader.onreading = (event) => {
		latestReading = event;
		guardTag(event);
		const listener = receive;

		receive = undefined;
		listener?.(event);
	};

	reader.onreadingerror = () => {
		tagGuard.abort(
			new Error(
				"Tag check: This tag could not be read. Hold one NDEF tag still, or try another tag.",
			),
		);
	};

	try {
		onState({ kind: "permission" });
		// Install the listener before scan so the first reading is never lost.
		const first = nextReading();

		// A permission failure can arrive before the first reading promise is awaited.
		void first.catch(() => undefined);
		await abortable(reader.scan({ signal: sessionSignal }), sessionSignal);
		onState({ kind: "waiting" });
		const preflight = await first;
		const occupied = preflight.message.records.some((record) => record.recordType !== "empty");

		if (occupied) {
			if (!preflight.serialNumber) {
				throw new Error(
					"Tag check: This phone cannot identify this tag safely for replacement. Use a blank tag instead. Its existing contents were kept.",
				);
			}

			protectedSerial = preflight.serialNumber;
			protectedContents = contents(preflight);

			if (latestReading) {
				guardTag(latestReading);
			}

			sessionSignal.throwIfAborted();

			const urls = preflight.message.records
				.filter((r) => r.recordType === "url")
				.map((r) => (r.data ? new TextDecoder().decode(r.data) : "Unreadable URL"));
			const differentRelic = urls.some((existing) => {
				try {
					return new URL(existing).pathname.startsWith("/relics/") && existing !== url;
				} catch {
					return false;
				}
			});

			onState({
				kind: "overwrite",
				existing: urls.join("\n") || "This tag already contains data.",
				differentRelic,
			});

			await abortable(confirmOverwrite(), sessionSignal);
			onState({ kind: "confirming" });
			await nextReading();
			sessionSignal.throwIfAborted();
			protectedContents = undefined;
		}

		sessionSignal.throwIfAborted();
		onState({ kind: "writing" });

		await abortable(
			reader.write(
				{ records: [{ recordType: "url", data: url }] },
				{ signal: sessionSignal, overwrite: occupied },
			),
			sessionSignal,
		);

		// Only a new event after write resolves may verify the physical tag.
		const verification = nextReading();

		onState({ kind: "verifying" });
		const readback = await verification;

		if (
			preflight.serialNumber &&
			readback.serialNumber &&
			preflight.serialNumber !== readback.serialNumber
		) {
			throw new Error(
				"Tag check: A different physical tag was scanned. The checklist was not saved. Start again with one tag.",
			);
		}

		const record = readback.message.records.at(0);

		if (
			readback.message.records.length !== 1 ||
			record?.recordType !== "url" ||
			!record.data ||
			new TextDecoder().decode(record.data) !== url
		) {
			throw new Error(
				"Tag check: The URL read back does not exactly match this relic. The checklist was not saved. Try writing this tag again.",
			);
		}

		sessionSignal.throwIfAborted();
	} finally {
		reader.onreading = null;
		reader.onreadingerror = null;
		tagGuard.abort();
	}
}
