import { createEffectApi } from "@petalnet/effect-api";

import favicon from "../assets/favicon.svg";
import { enrollAgentSelfOperation } from "./actors/api";
import type { ActorAuthority } from "./actors/authority";
import type { InvocationContext } from "./invocation";
import { projectOperations } from "./projects/api";
import type { ProjectService } from "./projects/service";
import { sproutOperations } from "./sprouts/api";
import type { SproutCommands } from "./sprouts/service";

import groveTheme from "../../theme.css?inline";
import docsStyles from "./api-docs.css?inline";

/** One HTTP application, built and disposed with the Grove runtime. */
export const groveApi = createEffectApi<
	ActorAuthority | InvocationContext | SproutCommands | ProjectService
>({
	title: "Grove API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations: [enrollAgentSelfOperation, ...sproutOperations, ...projectOperations],
	scalar: {
		theme: "none",
		withDefaultFonts: false,
		favicon,
		customCss: `${groveTheme}\n${docsStyles}`,
	},
});
