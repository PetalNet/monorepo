import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import nodeAdapter from "@sveltejs/adapter-node";
import type { Adapter } from "@sveltejs/kit";
import { build } from "vite";

export type {
	ConnectionSocket,
	HandleWebsocket,
	WebsocketEvent,
	WebsocketProtocol,
} from "./types.js";

type AdapterOptions = Parameters<typeof nodeAdapter>[0];

const filesDir = fileURLToPath(new URL("../files", import.meta.url).href);

/**
 * SvelteKit adapter for Node with WebSocket support: extends @sveltejs/adapter-node, re-bundles its
 * intermediate output with a crossws runtime entry that imports the compiled server hooks, and
 * appends the upgrade attachment to the produced entrypoint — so `node build/index.js` serves both
 * HTTP and WebSockets and SvelteKit owns the upgrade.
 *
 * Vendored from github.com/sowahq/svelte-ws (MIT); transport swapped from `ws` to crossws and the
 * bundling step moved from raw rollup to Vite's SSR build.
 */
export default function adapter(opts: AdapterOptions = {}): Adapter {
	const { out = "build" } = opts ?? {};
	const base = nodeAdapter(opts);
	const baseAdapt = base.adapt.bind(base);

	return {
		...base,
		name: "@petalnet/svelte-ws",
		async adapt(builder) {
			await baseAdapt(builder);

			const tmp = builder.getBuildDirectory("adapter-node");
			builder.rimraf(`${out}/server`);

			const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
				dependencies?: Record<string, string>;
			};

			const hooksRel = existsSync(`${tmp}/entries/hooks.server.js`)
				? "./entries/hooks.server.js"
				: "./chunks/hooks.server.js";

			builder.copy(`${filesDir}/websocket-runtime.js`, `${tmp}/ws.js`, {
				replace: { SERVER_HOOKS: hooksRel },
			});

			await build({
				configFile: false,
				logLevel: "warn",
				build: {
					ssr: true,
					outDir: `${out}/server`,
					emptyOutDir: true,
					sourcemap: true,
					rollupOptions: {
						input: {
							index: `${tmp}/index.js`,
							ws: `${tmp}/ws.js`,
							manifest: `${tmp}/manifest.js`,
							// adapter-node emits an instrumentation entry when server tracing is enabled;
							// it must survive the re-bundle or the produced entrypoint cannot import it.
							...(existsSync(`${tmp}/instrumentation.server.js`)
								? { "instrumentation.server": `${tmp}/instrumentation.server.js` }
								: {}),
						},
						external: [
							...Object.keys(pkg.dependencies ?? {}).map(
								(dependency) => new RegExp(`^${dependency}(\\/.*)?$`),
							),
							/^@petalnet\/svelte-ws(\/.*)?$/,
						],
						output: {
							format: "esm",
							entryFileNames: "[name].js",
							chunkFileNames: "chunks/[name]-[hash].js",
						},
					},
				},
			});

			appendFileSync(
				`${out}/index.js`,
				"\nconst { default: attachWebsockets } = await import('./server/ws.js')\nawait attachWebsockets(server.server)\n",
				"utf8",
			);
		},
	};
}
