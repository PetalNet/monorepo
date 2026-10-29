import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const SHARED_DEFAULT = "@prisma/client default output (node_modules/.prisma/client)";

/** Where each app's Prisma generator writes its client. */
function generatedClientLocations(): Map<string, string> {
	const locations = new Map<string, string>();
	const apps = path.join(root, "apps");

	for (const app of readdirSync(apps)) {
		const schemaPath = path.join(apps, app, "prisma", "schema.prisma");

		if (!existsSync(schemaPath)) {
			continue;
		}

		const schema = readFileSync(schemaPath, "utf8");

		for (const block of schema.matchAll(/generator\s+\w+\s*\{([^}]*)\}/g)) {
			const body = block[1] ?? "";
			const output = /^\s*output\s*=\s*"([^"]+)"/m.exec(body)?.[1];

			locations.set(
				`apps/${app}`,
				output === undefined
					? SHARED_DEFAULT
					: path.relative(root, path.resolve(path.dirname(schemaPath), output)),
			);
		}
	}

	return locations;
}

describe("Prisma generated clients", () => {
	it("finds the Prisma apps", () => {
		expect([...generatedClientLocations().keys()]).toEqual(
			expect.arrayContaining(["apps/petalboard", "apps/slide"]),
		);
	});

	it("gives every app its own generated client", () => {
		// Two apps writing the same location overwrite each other's client on every
		// `prisma generate`, breaking whichever app generated first.
		const byLocation = new Map<string, string[]>();

		for (const [app, location] of generatedClientLocations()) {
			byLocation.set(location, [...(byLocation.get(location) ?? []), app]);
		}

		const shared = [...byLocation].filter(([, apps]) => apps.length > 1);

		expect(shared).toEqual([]);
	});
});
