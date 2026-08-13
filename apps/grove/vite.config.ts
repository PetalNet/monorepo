import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const excludeGroveDevModules = (): Plugin => {
	const prefix = "\0grove-production-boundary:";
	const modules = new Map([
		["#lib/dev-browser-logs.ts", "client-logs"],
		["$lib/server/dev/browser-logs", "server-logs"],
		["$lib/server/dev/control-plane", "control-plane"],
	]);
	return {
		name: "grove-production-boundary",
		enforce: "pre",
		resolveId: (source) => {
			const replacement = modules.get(source);
			return replacement ? `${prefix}${replacement}` : undefined;
		},
		load: (id) => {
			if (!id.startsWith(prefix)) return undefined;
			const unavailable =
				'const unavailable = () => { throw new Error("Grove development control plane is excluded from production builds") };';
			if (id === `${prefix}client-logs`)
				return `${unavailable} export { unavailable as installDevBrowserLogs };`;
			if (id === `${prefix}server-logs`)
				return `${unavailable} export { unavailable as ingestDevBrowserLogs };`;
			return `${unavailable} export { unavailable as devEndpointInventory, unavailable as runDevPreflight, unavailable as safeReturnTo };`;
		},
	};
};

export default defineConfig(({ command }) => ({
	build: {
		// Preserve light-dark(); its media-query fallback ignores explicit mode overrides.
		cssTarget: ["chrome123", "firefox120", "safari17.5"],
	},
	server: {
		allowedHosts: [".e2b.app", ".onamp.dev"],
	},
	plugins: [
		...(command === "build" ? [excludeGroveDevModules()] : []),
		tailwindcss(),
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
