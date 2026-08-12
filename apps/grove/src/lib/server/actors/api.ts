import { operation } from "@petalnet/effect-api";
import { Effect } from "effect";

import { EnrollAgentSelf, EnrolledAgent } from "../../actors/schema";
import { InvocationContext } from "../invocation";
import { ActorAuthority, ActorDenied } from "./authority";

export const enrollAgentSelfOperation = operation({
	name: "agents.enrollSelf",
	description: "Enroll this verified machine identity as an Agent on its local Home Host.",
	method: "POST",
	path: "/agents/enroll-self",
	input: EnrollAgentSelf,
	output: EnrolledAgent,
	handler: (input) =>
		Effect.gen(function* () {
			const { principal } = yield* InvocationContext;
			if (principal.kind !== "bootstrap" && principal.kind !== "agent")
				return yield* Effect.fail(new ActorDenied("A machine enrollment identity is required"));
			const authority = yield* ActorAuthority;
			return yield* authority.enrollSelf(principal, input);
		}),
	statusForError: () => 403,
	messageForError: (error) => error.message,
});
