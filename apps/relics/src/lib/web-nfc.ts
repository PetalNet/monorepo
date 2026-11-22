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
				: "NFC permission was blocked. Allow NFC in Chrome’s site settings, then try again over HTTPS.";
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

export async function writeVerifiedTag({
	url,
	signal,
	onState,
	confirmOverwrite,
}: {
	url: string;
	signal: AbortSignal;
	onState: (state: NfcState) => void;
	confirmOverwrite: () => Promise<void>;
}) {
	const Reader = window.NDEFReader;

	if (!Reader) {
		throw new DOMException("NFC unavailable", "NotSupportedError");
	}

	const reader = new Reader();
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
