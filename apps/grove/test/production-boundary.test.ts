import { fileURLToPath } from "node:url";

import { build } from "vite";
import { describe, expect, it } from "vitest";

import { excludeGroveDevModules } from "../vite.config";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = `${root}src/lib/server/production-boundary-fixture.ts`;
const devModule = `${root}src/lib/server/dev/control-plane.ts`;

const bundle = (code: string, specifier = devModule) =>
	build({
		configFile: false,
		root,
		logLevel: "silent",
		resolve: { alias: { "dev-alias": devModule } },
		plugins: [
			excludeGroveDevModules(),
			{
				name: "boundary-test-entry",
				async resolveId(source, importer) {
					if (source === entry) {
						return entry;
					}

					// Keep fixture JavaScript static; vary paths through Vite's resolver.
					if (source === "boundary-test-target") {
						return this.resolve(specifier, importer, { skipSelf: true });
					}

					return undefined;
				},
				load: (id) => (id === entry ? code : undefined),
			},
		],
		build: {
			write: false,
			minify: false,
			lib: { entry, formats: ["es"] },
		},
	});

describe("production development-module boundary", () => {
	it.each([
		"#lib/server/dev/control-plane.ts",
		"./dev/control-plane.ts",
		devModule,
		`${devModule}?variant=1`,
		"dev-alias",
		"#lib/dev/browser-logs.ts",
	])("rejects a live dynamic import using %s", async (specifier) => {
		await expect(
			bundle('export const load = () => import("boundary-test-target");', specifier),
		).rejects.toThrow("Production build retains a development import");
	});

	it("rejects a live static import", async () => {
		await expect(bundle('export { runDevPreflight } from "boundary-test-target";')).rejects.toThrow(
			"Production build retains a development import",
		);
	});

	it("allows development imports only when tree-shaken", async () => {
		const output = await bundle(`
			export const load = () => false ? import("boundary-test-target") : null;
		`);

		expect(output).toMatchObject([
			{
				output: [
					expect.objectContaining({
						imports: [],
						dynamicImports: [],
					}),
				],
			},
		]);
	});
});
