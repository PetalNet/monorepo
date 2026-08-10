// Make the pruned runtime manifest at /out self-contained.
//
// `pnpm deploy --prod` copies the app manifest verbatim, INCLUDING every `catalog:` spec and the
// full devDependencies block. /out has no pnpm-workspace.yaml, so nothing there can resolve a
// catalog reference and any pnpm command run against the deployed tree dies with:
//   ERR_PNPM_CATALOG_ENTRY_NOT_FOUND_FOR_SPEC  No catalog entry '@libsql/client' ... for catalog 'prod'
//
// That makes the deployed artifact non-portable in a way that is invisible until something tries to
// use it. This rewrites each catalog spec to the exact version the build actually installed, and
// drops devDependencies (a --prod deploy does not install them, so listing them is a lie the next
// tool trips over).
//
// Run by the Dockerfile build stage. Node strips the types at runtime; it is TypeScript rather than
// plain JS so that the repo's typed lint rules apply to it like anything else.
//
// Usage: node apps/collegemap/docker/resolve-runtime-manifest.ts <deploy-dir> <installed-modules-dir>

import { readFileSync, writeFileSync } from "node:fs";

interface Manifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

// Check arity rather than comparing each argument to undefined. process.argv is typed
// string[] without noUncheckedIndexedAccess, so TypeScript narrows a const away from
// `string | undefined` to `string` and then flags an === undefined guard as an
// impossible condition -- even though it is perfectly possible at run time.
const args = process.argv.slice(2);
if (args.length < 2) {
	console.error("usage: resolve-runtime-manifest.ts <deploy-dir> <installed-modules-dir>");
	process.exit(2);
}
const [outDir, modulesDir] = args;

const manifestPath = `${outDir}/package.json`;
const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

delete pkg.devDependencies;

const resolved: string[] = [];
const unresolved: string[] = [];
const dependencies = pkg.dependencies ?? {};

for (const [name, spec] of Object.entries(dependencies)) {
	if (!spec.startsWith("catalog:")) continue;
	try {
		const installed = JSON.parse(readFileSync(`${modulesDir}/${name}/package.json`, "utf8")) as {
			version?: string;
		};
		if (installed.version === undefined) {
			unresolved.push(`${name} (${spec}) - installed manifest has no version`);
			continue;
		}
		dependencies[name] = installed.version;
		resolved.push(`${name}@${installed.version}`);
	} catch {
		unresolved.push(`${name} (${spec}) - not installed at ${modulesDir}`);
	}
}

// Fail loudly. A catalog spec left in the manifest is exactly the state this script exists to
// prevent, and it would otherwise only surface at runtime inside the deployed container.
if (unresolved.length > 0) {
	console.error(`could not resolve ${unresolved.length.toString()} catalog spec(s):`);
	for (const entry of unresolved) console.error(`  ${entry}`);
	process.exit(1);
}

writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`resolved ${resolved.length.toString()} catalog spec(s): ${resolved.join(", ")}`);
