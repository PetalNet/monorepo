import { createEffectApi } from "@petalnet/effect-api";

import { enrollAgentSelfOperation } from "./actors/api";
import type { ActorAuthority } from "./actors/authority";
import type { InvocationContext } from "./invocation";
import { sproutOperations } from "./sprouts/api";
import type { SproutCommands } from "./sprouts/service";

/** One HTTP application, built and disposed with the Grove runtime. */
export const groveApi = createEffectApi<ActorAuthority | InvocationContext | SproutCommands>({
	title: "Grove sprouts API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations: sproutOperations,
	mcpOperations: [enrollAgentSelfOperation, ...sproutOperations].toSorted((left, right) =>
		left.name.localeCompare(right.name),
	),
});
