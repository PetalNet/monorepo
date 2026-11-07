import type { Job, PrinterState } from "$lib/api";
import type { TapeWidthMm } from "$lib/doc";

import { api, errorText } from "./client";
import { plainError } from "./words";

/** The server itself may be unreachable, which is different from the printer being offline. */
export type Connection =
	| { kind: "connecting" }
	| { kind: "connected"; printer: PrinterState; queue: { pending: number; current: Job | null } }
	| { kind: "unreachable"; message: string };

/** Whether a real print can go out now, and if not, why in a few words and in a sentence. */
export type Availability =
	| { kind: "ready" }
	| { kind: "unavailable"; reason: string; detail: string };

const FAST_MS = 4000;
const SLOW_MS = 20_000;

/** Polls /api/status gently: every 4 s while the page is visible, every 20 s when hidden. */
class PrinterStatus {
	connection = $state<Connection>({ kind: "connecting" });
	/** Render and record without printing. Shared, so the Print button can say what it will do. */
	dryRun = $state(false);
	#timer: ReturnType<typeof setTimeout> | undefined;
	#controller: AbortController | undefined;
	#started = false;

	get printer(): PrinterState | null {
		return this.connection.kind === "connected" ? this.connection.printer : null;
	}

	/** The tape width the printer reports, when it reports one. */
	get loadedTape(): TapeWidthMm | null {
		const printer = this.printer;

		if (!printer || printer.state === "offline") {
			return null;
		}

		return printer.tape?.widthMm ?? null;
	}

	get availability(): Availability {
		const connection = this.connection;

		switch (connection.kind) {
			case "connecting":
				return {
					kind: "unavailable",
					reason: "Checking printer",
					detail: "Checking the printer.",
				};
			case "unreachable":
				return { kind: "unavailable", reason: "Server offline", detail: connection.message };
			case "connected": {
				const { printer } = connection;

				if (printer.state === "ready") {
					return { kind: "ready" };
				}

				const detail = plainError(printer.message);

				return { kind: "unavailable", reason: detail.split(".")[0], detail };
			}
		}
	}

	start(): void {
		if (this.#started) {
			return;
		}

		this.#started = true;

		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") {
				void this.refresh();
			}
		});

		void this.refresh();
	}

	async refresh(): Promise<void> {
		clearTimeout(this.#timer);
		this.#controller?.abort();
		const controller = new AbortController();

		this.#controller = controller;

		try {
			const status = await api.status(controller.signal);

			this.connection = { kind: "connected", printer: status.printer, queue: status.queue };
		} catch (error) {
			if (controller.signal.aborted) {
				return;
			}

			this.connection = {
				kind: "unreachable",
				message: errorText(error, "Cannot reach Label Studio"),
			};
		}

		const delay = document.visibilityState === "visible" ? FAST_MS : SLOW_MS;

		this.#timer = setTimeout(() => void this.refresh(), delay);
	}
}

export const printerStatus = new PrinterStatus();
