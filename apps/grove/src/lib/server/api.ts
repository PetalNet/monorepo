import { building } from "$app/env";
import { GROVE_MCP_ISSUER, GROVE_MCP_JWKS_URL, GROVE_MCP_RESOURCE } from "$app/env/private";
import { createMcpAuthentication } from "@petalnet/effect-api/better-auth";
import { createServer } from "@petalnet/effect-sveltekit";
import { Effect } from "effect";
import { globalFontFaces } from "fontless/runtime";

import favicon from "../assets/favicon.svg";
import { enrollAgentSelfOperation } from "./actors/api";
import { authenticationErrors, browserAuthentication } from "./authentication";
import { authenticateMachine } from "./mcp/ingress";
import { projectOperations } from "./projects/api";
import { GroveServicesLayer, mapGroveFailure } from "./services";

import groveTheme from "../../theme.css?inline";
import docsStyles from "./api-docs.css?inline";

/** One HTTP application, built and disposed with the Grove runtime. */
export const groveApi = createServer({
	title: "Grove API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations: [enrollAgentSelfOperation, ...projectOperations],
	services: GroveServicesLayer,
	mapFailure: mapGroveFailure,
	auth: {
		browser: browserAuthentication,
		errors: authenticationErrors,
		mcp: building
			? false
			: createMcpAuthentication(
					Effect.sync(() => ({
						issuer: GROVE_MCP_ISSUER ?? "",
						jwksUrl: GROVE_MCP_JWKS_URL ?? "",
						resourceOrigin: GROVE_MCP_RESOURCE ?? "",
						requiredScopes: ["grove:mcp"],
						scopesSupported: ["grove:mcp", "grove:agent:enroll"],
						authenticate: authenticateMachine,
					})),
				),
	},
	scalar: {
		theme: "none",
		withDefaultFonts: false,
		favicon,
		customCss: `${globalFontFaces}\n${groveTheme}\n${docsStyles}`,
	},
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => void groveApi.dispose());
}
