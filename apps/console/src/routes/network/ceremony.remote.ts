import type { EdgeRegistryItem } from "$lib/api/types";
import { publicConfig } from "$lib/config";
import { mockPendingKey, mockRegistry } from "$lib/data/network";
import { captureCaughtFailure } from "$lib/glitchtip";
import { executeNamedOp } from "$lib/operations.remote";
import { currentPrincipal } from "$lib/server/domain/principal";
import { readEntity } from "$lib/server/domain/reads/entities";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { ConsoleDomain } from "$lib/server/domain/service";
import { Effect, Schema } from "effect";
import { Command, Error as HttpError, Query, RequestEvent } from "svelte-effect-runtime";

const fingerprint = Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256));
const handle = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(64),
	Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);
const reason = Schema.Trim.check(Schema.isMinLength(3), Schema.isMaxLength(500));
const approveInput = Schema.Struct({ pubkey_fp: fingerprint, handle }).annotate(rejectUnknownKeys);
const denyInput = Schema.Struct({ pubkey_fp: fingerprint, reason }).annotate(rejectUnknownKeys);
const revokeInput = Schema.Struct({
	pubkey_fp: fingerprint,
	handle,
	confirm_name: handle,
	reason,
}).annotate(rejectUnknownKeys);

export interface KeyCeremonySurface {
	readonly registry: EdgeRegistryItem[];
	readonly observed_at: string | null;
	readonly registry_available: boolean;
	readonly executor: {
		readonly configured: boolean;
		readonly live: boolean;
		readonly detail: string;
	};
	readonly is_mock: boolean;
}

const mockStates = new Map<string, EdgeRegistryItem["state"] | "denied">();

function isMock(): boolean {
	return publicConfig.dataMode === "mock";
}

function mockSurface(showPending: boolean): KeyCeremonySurface {
	const source = showPending ? [mockPendingKey, ...mockRegistry] : mockRegistry;
	return {
		registry: source.flatMap((item) => {
			const state = mockStates.get(item.pubkey_fp) ?? item.state;
			return state === "denied" ? [] : [{ ...item, state }];
		}),
		observed_at: new Date().toISOString(),
		registry_available: true,
		executor: { configured: true, live: true, detail: "Mock doorman is ready" },
		is_mock: true,
	};
}

export const getKeyCeremony = Query(
	Effect.gen(function* () {
		if (isMock()) {
			const event = yield* RequestEvent;
			return mockSurface(event.url.searchParams.get("scene") === "asked");
		}
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		return yield* Effect.gen(function* () {
			const registry = yield* readEntity(services.db.app, principal.scopes, "edge", {
				limit: 1_000,
				requiredFields: ["pubkey_fp", "state"],
			});
			const keyCeremony = services.keyCeremony;
			const configured = keyCeremony !== null;
			const live = keyCeremony ? yield* Effect.promise(() => keyCeremony.health()) : false;
			return {
				// The scoped `edge` projection is untyped lake JSON; narrowing its rows to the
				// EdgeRegistryItem contract is the one genuine unknown-JSON narrowing at this seam.
				registry: registry.items as EdgeRegistryItem[],
				observed_at: registry.freshness.observed_at,
				registry_available: true,
				executor: {
					configured,
					live,
					detail: !configured
						? "Doorman key ceremony is not configured"
						: live
							? "Doorman key ceremony answered its private health check"
							: "Doorman key ceremony is not answering",
				},
				is_mock: false,
			} satisfies KeyCeremonySurface;
		}).pipe(
			Effect.catch((cause) => {
				captureCaughtFailure(cause, { surface: "network", endpoint: "/network/key-ceremony" });
				return Effect.succeed({
					registry: [],
					observed_at: null,
					registry_available: false,
					executor: {
						configured: false,
						live: false,
						detail: "Key registry and doorman availability could not be verified",
					},
					is_mock: false,
				} satisfies KeyCeremonySurface);
			}),
		);
	}),
);

function runCeremonyOp(
	op: "edge.enroll.approve" | "edge.enroll.deny" | "edge.key.revoke",
	args: Record<string, string>,
	reasonText?: string,
): Effect.Effect<Record<string, unknown>, unknown> {
	return Effect.gen(function* () {
		const result = yield* executeNamedOp({
			id: crypto.randomUUID(),
			op,
			args,
			...(reasonText ? { reason: reasonText } : {}),
			dry_run: false,
		});
		if (!result.ok) return yield* HttpError("BadRequest", result.error.message);
		return result.result ?? {};
	});
}

export const approveEnrollment = Command(approveInput, (input) =>
	Effect.gen(function* () {
		if (isMock()) {
			mockStates.set(input.pubkey_fp, "enrolled");
			return { state: "enrolled" as const, handle: input.handle };
		}
		return yield* runCeremonyOp("edge.enroll.approve", input);
	}),
);

export const denyEnrollment = Command(denyInput, ({ reason: reasonText, ...args }) =>
	Effect.gen(function* () {
		if (isMock()) {
			mockStates.set(args.pubkey_fp, "denied");
			return { state: "denied" as const };
		}
		return yield* runCeremonyOp("edge.enroll.deny", args, reasonText);
	}),
);

export const revokeKey = Command(revokeInput, ({ reason: reasonText, handle: _handle, ...args }) =>
	Effect.gen(function* () {
		if (isMock()) {
			mockStates.set(args.pubkey_fp, "revoked");
			return { state: "revoked" as const };
		}
		return yield* runCeremonyOp("edge.key.revoke", args, reasonText);
	}),
);
