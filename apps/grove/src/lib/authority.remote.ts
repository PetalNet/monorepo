import { form, getRequestEvent } from "$app/server";
import { Effect } from "effect";

import { AgentCapabilityValidator, ContainmentFixValidator } from "./actors/schema";
import {
	ActorAuthority,
	CapabilityContainmentConflict,
	CurrentPrincipal,
} from "./server/actors/authority";
import { groveApi } from "./server/api";

export const requestAgentCapability = form(AgentCapabilityValidator, (input) =>
	groveApi.run(
		Effect.gen(function* () {
			const principal = yield* CurrentPrincipal;

			if (principal.kind !== "person") {
				return { ok: false as const, message: "Person required" };
			}

			const authority = yield* ActorAuthority;

			return yield* authority
				.requestAgentCapability(principal, input.agentId, input.capability)
				.pipe(
					Effect.as({ ok: true as const }),
					Effect.catchIf(
						(error): error is CapabilityContainmentConflict =>
							error instanceof CapabilityContainmentConflict,
						(error) =>
							Effect.succeed({
								ok: false as const,
								conflicts: error.conflicts,
								fixes: error.fixes,
							}),
					),
				);
		}),
		getRequestEvent(),
	),
);

export const resolveContainmentConflict = form(ContainmentFixValidator, ({ fix }) =>
	groveApi.run(
		Effect.gen(function* () {
			const principal = yield* CurrentPrincipal;

			if (principal.kind !== "person") {
				return { ok: false as const };
			}

			const authority = yield* ActorAuthority;

			yield* authority.applyContainmentFixAs(principal, fix);

			return { ok: true as const, agentId: fix.agentId, capability: fix.capability };
		}),
		getRequestEvent(),
	),
);
