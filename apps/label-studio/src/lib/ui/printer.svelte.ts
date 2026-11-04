import type { Job, PrinterState } from "$lib/api";
import type { TapeWidthMm } from "$lib/doc";

import { api, errorText } from "./client";

/** The server itself may be unreachable, which is different from the printer being offline. */
export type Connection =
	| { kind: "connecting" }
	| { kind: "connected"; printer: PrinterState; queue: { pending: number; current: Job | null } }
	| { kind: "unreachable"; message: string };

const FAST_MS = 4000;
const SLOW_MS = 20_000;

/** Polls /api/status gently: every 4 s while the page is visible, every 20 s when hidden. */
class PrinterStatus {
	connection = $state<Connection>({ kind: "connecting" });
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
