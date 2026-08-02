import { publicConfig } from "$lib/config";
import { mockPtyLines } from "$lib/data/terminal";
import { currentPrincipal } from "$lib/server/domain/principal";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { ConsoleDomain } from "$lib/server/domain/service";
import { TerminalDomainError, terminalService } from "$lib/server/domain/terminal/service";
import { Effect, Schema } from "effect";
import { Command, Error as HttpError, Query } from "svelte-effect-runtime";

const targetSchema = Schema.Struct({
	host: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
	tmux_session: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
	pane_id: Schema.String.check(Schema.isPattern(/^%[0-9]+$/)),
}).annotate(rejectUnknownKeys);
const streamIdSchema = Schema.Union([
	Schema.String.check(Schema.isUUID()),
	Schema.String.check(Schema.isPattern(/^mock-/)),
]);
const pollSchema = Schema.Struct({
	stream_id: streamIdSchema,
	tick: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}).annotate(rejectUnknownKeys);
const detachSchema = Schema.Struct({ stream_id: streamIdSchema }).annotate(rejectUnknownKeys);

export interface PtySnapshot {
	readonly stream_id: string;
	readonly seq: number;
	readonly data_b64: string;
}

function mockSnapshot(streamId = `mock-${crypto.randomUUID()}`, seq = 1): PtySnapshot {
	return {
		stream_id: streamId,
		seq,
		data_b64: Buffer.from(mockPtyLines.join("\n")).toString("base64"),
	};
}

const mapTerminalError = (cause: TerminalDomainError) =>
	HttpError(
		cause.status === 403
			? "Forbidden"
			: cause.status === 404
				? "NotFound"
				: cause.status === 502
					? "BadGateway"
					: "ServiceUnavailable",
		cause.message,
	);

/** Opens the audited read-only PTY path. No attach or input operation is exposed by this module. */
export const openTerminalPeek = Command(targetSchema, (target) =>
	Effect.gen(function* () {
		if (publicConfig.dataMode === "mock") return mockSnapshot();
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		return yield* terminalService(services)
			.openPeek(
				principal,
				{ host: target.host, tmuxSession: target.tmux_session, paneId: target.pane_id },
				10_000,
			)
			.pipe(Effect.catch(mapTerminalError));
	}),
);

/** Polls an already-authorized server session; tick prevents Remote Function result reuse. */
export const pollTerminalPeek = Query(pollSchema, ({ stream_id, tick }) =>
	Effect.gen(function* () {
		if (publicConfig.dataMode === "mock") return mockSnapshot(stream_id, tick + 1);
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		return yield* terminalService(services)
			.pollPeek(principal, stream_id)
			.pipe(Effect.catch(mapTerminalError));
	}),
);

export const closeTerminalPeek = Command(detachSchema, ({ stream_id }) =>
	Effect.gen(function* () {
		if (publicConfig.dataMode === "mock") return;
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		const service = terminalService(services);
		const session = yield* service.owned(principal, stream_id).pipe(Effect.catch(mapTerminalError));
		yield* service
			.audit(principal, "detach", session.target, stream_id)
			.pipe(Effect.catch(mapTerminalError));
		service.close(stream_id);
		session.end();
	}),
);
