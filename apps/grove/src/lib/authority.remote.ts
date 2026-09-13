import { form, getRequestEvent } from "$app/server";
import { Effect } from "effect";

import { AgentCapabilityValidator, ContainmentFixValidator } from "./actors/schema";
import { ActorAuthority, CapabilityContainmentConflict } from "./server/actors/authority";
import { InvocationContext, withBrowserInvocation } from "./server/invocation";
import { runGrove } from "./server/runtime";

export const requestAgentCapability = form(AgentCapabilityValidator, (input) =>
	runGrove(
		withBrowserInvocation(
			Effect.gen(function* () {
				const { principal } = yield* InvocationContext;
				if (principal.kind !== "person") return { ok: false as const, message: "Person required" };
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
		),
		getRequestEvent(),
	),
);

export const resolveContainmentConflict = form(ContainmentFixValidator, (input) =>
	runGrove(
		withBrowserInvocation(
			Effect.gen(function* () {
				const { principal } = yield* InvocationContext;
				if (principal.kind !== "person") return { ok: false as const };
				const authority = yield* ActorAuthority;
				yield* authority.applyContainmentFixAs(principal, input);
				return { ok: true as const };
			}),
		),
		getRequestEvent(),
	),
);
