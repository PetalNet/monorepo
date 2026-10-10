import { createEffectApi } from "@petalnet/effect-api";
import { globalFontFaces } from "fontless/runtime";

import favicon from "../assets/favicon.svg";
import { enrollAgentSelfOperation } from "./actors/api";
import { projectOperations } from "./projects/api";

import groveTheme from "../../theme.css?inline";
import docsStyles from "./api-docs.css?inline";

/** One HTTP application, built and disposed with the Grove runtime. */
export const groveApi = createEffectApi({
	title: "Grove API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations: [enrollAgentSelfOperation, ...projectOperations],
	scalar: {
		theme: "none",
		withDefaultFonts: false,
		favicon,
		customCss: `${globalFontFaces}\n${groveTheme}\n${docsStyles}`,
	},
});
