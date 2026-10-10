import { operation } from "@petalnet/effect-api";
import { Effect } from "effect";

import { EnrollAgentSelf, EnrolledAgent } from "../../actors/schema";
import { InvocationContext } from "../invocation";
import { ActorAuthority, ActorDenied } from "./authority";

export const enrollAgentSelfOperation = operation({
	name: "agents.enrollSelf",
	description: "Enroll this verified machine identity as an Agent on its local Home Host.",
	input: EnrollAgentSelf,
	output: EnrolledAgent,
	handler: (input) =>
		Effect.gen(function* () {
			const { principal } = yield* InvocationContext;

			if (principal.kind !== "bootstrap" && principal.kind !== "agent") {
				return yield* new ActorDenied({ reason: "A machine enrollment identity is required" });
			}

			const authority = yield* ActorAuthority;
			const enrolled = yield* authority.enrollSelf(principal, input);

			return {
				kind: enrolled.kind,
				actorId: enrolled.actorId,
				name: enrolled.name,
				homeHostId: enrolled.homeHostId,
				ownerPersonId: enrolled.ownerPersonId,
			};
		}),
	errors: {
		ActorDenied: { status: 403, message: (error) => error.message },
		ActorNotCurrent: { status: 403, message: (error) => error.message },
		ActorDatabaseError: { status: 403, message: (error) => error.message },
		HomeOwnerUnbound: { status: 403, message: (error) => error.message },
		CapabilityContainmentConflict: { status: 403, message: (error) => error.message },
	},
});
