import type { PrinterState } from "$lib/api";
import { isTapeWidth, tapeGeometry } from "$lib/doc";

export interface PrintOptions {
	copies: number;
	cut: boolean;
	chain: boolean;
	expectWidthMm: number;
}

export type PrintOutcome = { ok: true } | { ok: false; message: string };

export interface Printer {
	status: () => Promise<PrinterState>;
	print: (pages: readonly Uint8Array[], options: PrintOptions) => Promise<PrintOutcome>;
}

/** Daemon 503 details, matched by substring, to the message a person sees. */
const STATUS_ERRORS: readonly { match: string; state: "error" | "offline"; message: string }[] = [
	{ match: "no tape", state: "error", message: "No tape" },
	{ match: "cover open", state: "error", message: "Cover open" },
	{ match: "wrong tape", state: "error", message: "Wrong tape" },
	{ match: "cutter jam", state: "error", message: "Cutter jam" },
	{ match: "overheated", state: "error", message: "Printer overheated" },
	{ match: "unsupported tape width", state: "error", message: "Unsupported tape" },
	{ match: "not found", state: "offline", message: "Printer not connected" },
];

const UNREACHABLE = "Print server unreachable";

export function createPrinter(
	baseUrl: string,
	timeouts = { statusMs: 5000, printMs: 120_000 },
): Printer {
	return {
		async status() {
			let response: Response;

			try {
				response = await fetch(`${baseUrl}/api/status`, {
					signal: AbortSignal.timeout(timeouts.statusMs),
				});
			} catch {
				return { state: "offline", message: UNREACHABLE };
			}

			const body = await readJson(response);

			if (response.ok) {
				const width = isRecord(body) ? body.width_mm : undefined;

				return isTapeWidth(width)
					? { state: "ready", tape: tapeGeometry(width) }
					: { state: "error", message: "Unsupported tape", tape: null };
			}

			const detail = detailOf(body) ?? `Print server answered HTTP ${String(response.status)}`;
			const known = STATUS_ERRORS.find((entry) => detail.toLowerCase().includes(entry.match));

			if (known?.state === "offline") {
				return { state: "offline", message: known.message };
			}

			return { state: "error", message: known?.message ?? sentence(detail), tape: null };
		},

		async print(pages, options) {
			const form = new FormData();

			for (const [index, page] of pages.entries()) {
				form.append(
					"pages",
					new Blob([page as Uint8Array<ArrayBuffer>], { type: "image/png" }),
					`page-${String(index)}.png`,
				);
			}

			form.append("copies", String(options.copies));
			form.append("cut", String(options.cut));
			form.append("chain", String(options.chain));
			form.append("expect_width_mm", String(options.expectWidthMm));
			let response: Response;

			try {
				response = await fetch(`${baseUrl}/api/print/raster`, {
					method: "POST",
					body: form,
					signal: AbortSignal.timeout(timeouts.printMs),
				});
			} catch (error) {
				return {
					ok: false,
					message:
						error instanceof DOMException && error.name === "TimeoutError"
							? "Print server timed out; check the printer before retrying"
							: UNREACHABLE,
				};
			}

			if (response.ok) {
				return { ok: true };
			}

			const detail = detailOf(await readJson(response));

			return {
				ok: false,
				message: sentence(detail ?? `Print server answered HTTP ${String(response.status)}`),
			};
		},
	};
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** FastAPI puts errors in `detail`: a string, or a list of validation problems. */
function detailOf(body: unknown): string | null {
	if (!isRecord(body)) {
		return null;
	}

	const { detail } = body;

	if (typeof detail === "string") {
		return detail;
	}

	if (Array.isArray(detail)) {
		return detail
			.map((item: unknown) => (isRecord(item) && typeof item.msg === "string" ? item.msg : ""))
			.filter(Boolean)
			.join("; ");
	}

	return null;
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
