import { createEffectApi } from "@petalnet/effect-api";

import { enrollAgentSelfOperation } from "./actors/api";
import type { ActorAuthority } from "./actors/authority";
import type { InvocationContext } from "./invocation";
import { projectOperations } from "./projects/api";
import type { ProjectService } from "./projects/service";

/** One HTTP application, built and disposed with the Grove runtime. */
export const groveApi = createEffectApi<ActorAuthority | InvocationContext | ProjectService>({
	title: "Grove API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations: [enrollAgentSelfOperation, ...projectOperations],
});
