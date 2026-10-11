import { operation, type OperationErrors } from "@petalnet/effect-api";
import { Effect } from "effect";

import { EnrollAgentSelf, EnrolledAgent } from "../../actors/schema";
import { InvocationContext } from "../invocation";
import { ActorAuthority, ActorDenied, type AuthorityError } from "./authority";

export const authorityErrors = {
	ActorDenied: { status: 403, message: (error) => error.message },
	ActorNotCurrent: { status: 403, message: (error) => error.message },
	ActorDatabaseError: { status: 503, message: "Actor authority is unavailable" },
	HomeOwnerUnbound: {
		status: 503,
		message: "The configured Home Host owner has not completed a verified browser login",
	},
	CapabilityContainmentConflict: {
		status: 409,
		message: "Agent capability containment would be violated",
	},
} satisfies OperationErrors<AuthorityError>;

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
	errors: authorityErrors,
});
