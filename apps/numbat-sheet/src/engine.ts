import {
	type CellId,
	type CellOutcome,
	type CellResult,
	ERROR_CODES,
	type ErrorCode,
	recalculate,
} from "./sheet.ts";

/** The subset of the wasm-bindgen output (`pnpm build:wasm`) this app uses. */
interface EngineModule {
	default: () => Promise<unknown>;
	Engine: new () => { session: () => Session };
}

interface Session {
	define: (name: string, expr: string) => WasmOutcome;
	free: () => void;
}

interface WasmOutcome {
	code: string | undefined;
	text: string;
	full: string | undefined;
	free: () => void;
}

export type Evaluate = (inputs: ReadonlyMap<CellId, string>) => Map<CellId, CellResult>;

export const BUILD_COMMAND = "pnpm --filter @petalnet/numbat-sheet build:wasm";

function isEngineModule(module: unknown): module is EngineModule {
	return (
		typeof module === "object" &&
		module !== null &&
		"default" in module &&
		typeof module.default === "function" &&
		"Engine" in module &&
		typeof module.Engine === "function"
	);
}

const isErrorCode = (code: string): code is ErrorCode =>
	(ERROR_CODES as readonly string[]).includes(code);

function parseOutcome({ code, text, full }: WasmOutcome): CellOutcome {
	if (code === undefined) {
		return { ok: true, display: text, full: full ?? text };
	}

	return { ok: false, code: isErrorCode(code) ? code : "#ERROR", message: text };
}

export async function loadEngine(): Promise<Evaluate> {
	// An absolute URL keeps Vite dev from tagging the import with ?import, which it refuses for public/.
	const url = new URL(`${import.meta.env.BASE_URL}engine/numbat_sheet_engine.js`, location.href)
		.href;
	const module: unknown = await import(/* @vite-ignore */ url);

	if (!isEngineModule(module)) {
		throw new Error(`${url} is not the numbat-sheet engine`);
	}

	await module.default();
	const engine = new module.Engine();

	return (inputs) => {
		const session = engine.session();

		try {
			return recalculate(inputs, (id, expr) => {
				const outcome = session.define(id, expr);
				const parsed = parseOutcome(outcome);

				outcome.free();

				return parsed;
			});
		} finally {
			session.free();
		}
	};
}
