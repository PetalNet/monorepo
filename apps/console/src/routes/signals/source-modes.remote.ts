import type { SignalSourceModeItem } from "$lib/api/types";
import { publicConfig } from "$lib/config";
import { executeNamedOp } from "$lib/operations.remote";
import { currentPrincipal } from "$lib/server/domain/principal";
import { readSignalSourceModes } from "$lib/server/domain/reads/entities";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { ConsoleDomain } from "$lib/server/domain/service";
import { Effect, Schema } from "effect";
import { Command, Error as HttpError, Query } from "svelte-effect-runtime";

let mockModes: SignalSourceModeItem[] = [
	{
		source_service: "box-agent",
		mode: "development",
		note: "test-container work",
		updated_at: new Date(Date.now() - 18 * 60_000).toISOString(),
		updated_by: "janet",
	},
];

function isMock(): boolean {
	return publicConfig.dataMode === "mock";
}

export const getSignalSourceModes = Query(
	Effect.gen(function* () {
		if (isMock()) return mockModes;
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		const response = yield* readSignalSourceModes(services.db.app, principal.scopes, {
			limit: 1_000,
		});
		// current_state rows arrive as untyped JSON (ReadEnvelope.items: Record<string, unknown>[]);
		// narrowing to the closed contract shape is the rare rule-4 JSON narrowing, not a mock cast.
		return response.items as SignalSourceModeItem[];
	}),
);

const modeArgs = Schema.Struct({
	sourceService: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)),
	mode: Schema.Literals(["normal", "development"]),
	note: Schema.optional(Schema.String.check(Schema.isMaxLength(240))),
}).annotate(rejectUnknownKeys);

export const setSignalSourceMode = Command(modeArgs, ({ sourceService, mode, note }) =>
	Effect.gen(function* () {
		if (isMock()) {
			const previousMode =
				mockModes.find((item) => item.source_service === sourceService)?.mode ?? "normal";
			const saved: SignalSourceModeItem = {
				source_service: sourceService,
				mode,
				note: note?.trim() || null,
				updated_at: new Date().toISOString(),
				updated_by: "parker",
			};
			mockModes = [...mockModes.filter((item) => item.source_service !== sourceService), saved];
			yield* getSignalSourceModes().refresh();
			return {
				item: saved,
				undo: {
					op: "signal.source_mode",
					args: { source_service: sourceService, mode: previousMode },
				},
			};
		}
		const result = yield* executeNamedOp({
			id: crypto.randomUUID(),
			op: "signal.source_mode",
			args: {
				source_service: sourceService,
				mode,
				...(note?.trim() ? { note: note.trim() } : {}),
			},
			dry_run: false,
		});
		if (!result.ok) return yield* HttpError("BadRequest", result.error.message);
		yield* getSignalSourceModes().refresh();
		return {
			item: result.result as SignalSourceModeItem,
			...(result.undo ? { undo: result.undo } : {}),
		};
	}),
);
