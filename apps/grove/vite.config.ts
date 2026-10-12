import { fileURLToPath } from "node:url";

import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { fontless } from "fontless";
import { defineConfig, type Plugin } from "vite";

export const excludeGroveDevModules = (): Plugin => {
	const root = fileURLToPath(new URL("src/lib/", import.meta.url)).replaceAll("\\", "/");
	const forbidden = new Set<string>();

	return {
		name: "grove-production-boundary",
		enforce: "pre",
		async resolveId(source, importer) {
			const resolved = await this.resolve(source, importer, { skipSelf: true });

			if (!resolved) {
				return undefined;
			}

			const path = resolved.id.replaceAll("\\", "/").split(/[?#]/)[0];

			if (!path.startsWith(`${root}server/dev/`) && !path.startsWith(`${root}dev/`)) {
				return undefined;
			}

			forbidden.add(resolved.id);

			// Never load dev implementations. Dead imports can tree-shake; live ones
			// remain external and are rejected below, rather than replaced with stubs.
			return { id: resolved.id, external: "absolute", moduleSideEffects: false };
		},
		generateBundle(_options, bundle) {
			for (const output of Object.values(bundle)) {
				if (output.type !== "chunk") {
					continue;
				}

				for (const id of [...output.imports, ...output.dynamicImports]) {
					if (forbidden.has(id)) {
						this.error(`Production build retains a development import: ${id}`);
					}
				}
			}
		},
	};
};

export default defineConfig(({ command }) => ({
	build: {
		// Preserve light-dark(); its media-query fallback ignores explicit mode overrides.
		cssTarget: ["chrome123", "firefox120", "safari17.5"],
		// Better Auth imports this only without a database. Grove always supplies
		// Drizzle; leave the removed fallback unresolved rather than bundling it.
		rolldownOptions: { external: ["@better-auth/memory-adapter"] },
	},
	server: {
		allowedHosts: [".e2b.app", ".onamp.dev"],
	},
	ssr: { noExternal: ["fontless/runtime"] },
	plugins: [
		...(command === "build" ? [excludeGroveDevModules()] : []),
		tailwindcss(),
		fontless({
			families: [
				{
					name: "Schibsted Grotesk",
					provider: "fontsource",
					weights: [400, 500, 600],
					global: true,
				},
				{ name: "IBM Plex Mono", provider: "fontsource", weights: [400], global: true },
			],
		}),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
				experimental: { async: true },
			},

			adapter: adapter(),
			experimental: { remoteFunctions: true },
		}),
	],
}));
