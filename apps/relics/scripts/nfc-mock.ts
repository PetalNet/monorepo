export function installNfcMock() {
	interface Reading {
		serialNumber: string;
		message: { records: { recordType: string; data?: DataView }[] };
	}
	const readers: Reader[] = [];
	const writes: { url: string; serial: string; overwrite: boolean }[] = [];
	const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
	let tag: { url: string; serial: string } | null = null;
	let failure: string | null = null;
	let scans = 0;
	const permission: { state: PermissionState; onchange: (() => void) | null } = {
		state: "prompt",
		onchange: null,
	};
	const query = navigator.permissions.query.bind(navigator.permissions);

	Object.defineProperty(navigator.permissions, "query", {
		value: (descriptor: PermissionDescriptor | { name: "nfc" }) =>
			descriptor.name === "nfc" ? Promise.resolve(permission) : query(descriptor),
	});

	class Reader {
		onreading: ((event: Reading) => void) | null = null;
		onreadingerror: (() => void) | null = null;
		signal: AbortSignal | undefined;
		constructor() {
			readers.push(this);
		}
		async scan({ signal }: { signal: AbortSignal }) {
			this.signal = signal;
			scans++;
			signal.throwIfAborted();

			if (permission.state === "prompt") {
				await new Promise<void>((resolve, reject) => {
					pending.push({ resolve, reject });

					signal.addEventListener(
						"abort",
						() => {
							reject(new DOMException("Cancelled", "AbortError"));
						},
						{ once: true },
					);
				});
			}

			if (permission.state === "denied") {
				throw new DOMException("NFC denied", "NotAllowedError");
			}

			signal.throwIfAborted();
		}
		write(
			message: { records: { data: string }[] },
			{ signal, overwrite }: { signal: AbortSignal; overwrite: boolean },
		) {
			return Promise.resolve().then(() => {
				signal.throwIfAborted();

				if (!tag) {
					throw new DOMException("No tag", "NetworkError");
				}

				if (failure) {
					const name = failure;

					failure = null;

					throw new DOMException("NFC failure", name);
				}

				if (tag.url && !overwrite) {
					throw new DOMException("Occupied", "NotAllowedError");
				}

				const url = message.records[0]?.data;

				if (!url) {
					throw new Error("Missing URL record");
				}

				writes.push({ url, serial: tag.serial, overwrite });
				tag.url = url;

				return undefined;
			});
		}
	}

	const state = {
		writes,
		get scans() {
			return scans;
		},
		get permission() {
			return permission.state;
		},
		get waitingForPermission() {
			return pending.length > 0;
		},
		get tag() {
			return tag;
		},
		allow(allowed = true) {
			permission.state = allowed ? "granted" : "denied";
			permission.onchange?.();

			for (const waiter of pending.splice(0)) {
				if (allowed) {
					waiter.resolve();
				} else {
					waiter.reject(new DOMException("NFC denied", "NotAllowedError"));
				}
			}
		},
		remove() {
			tag = null;
		},
		failNext(name: string) {
			failure = name;
		},
		present(url = "", serial = "04:AB:CD:01") {
			tag = { url, serial };
			const bytes = new TextEncoder().encode(url);

			for (const reader of readers) {
				if (reader.signal && !reader.signal.aborted) {
					reader.onreading?.({
						serialNumber: serial,
						message: {
							records: url
								? [{ recordType: "url", data: new DataView(bytes.buffer) }]
								: [{ recordType: "empty" }],
						},
					});
				}
			}
		},
		reread() {
			if (tag) {
				state.present(tag.url, tag.serial);
			}
		},
	};

	Object.defineProperty(window, "NDEFReader", { value: Reader, configurable: true });
	Object.defineProperty(window, "nfcMock", { value: state });

	return state;
}

declare global {
	interface Window {
		nfcMock: ReturnType<typeof installNfcMock>;
	}
}
