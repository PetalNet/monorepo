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
// Usage: node apps/collegemap/docker/resolve-runtime-manifest.mjs <deploy-dir> <installed-modules-dir>

import { readFileSync, writeFileSync } from "node:fs";

const [, , outDir, modulesDir] = process.argv;
if (!outDir || !modulesDir) {
  console.error("usage: resolve-runtime-manifest.mjs <deploy-dir> <installed-modules-dir>");
  process.exit(2);
}

const manifestPath = `${outDir}/package.json`;
const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));

delete pkg.devDependencies;

const resolved = [];
const unresolved = [];

for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (!String(spec).startsWith("catalog:")) continue;
  try {
    const installed = JSON.parse(readFileSync(`${modulesDir}/${name}/package.json`, "utf8"));
    pkg.dependencies[name] = installed.version;
    resolved.push(`${name}@${installed.version}`);
  } catch {
    unresolved.push(`${name} (${spec})`);
  }
}

// Fail loudly. A catalog spec left in the manifest is exactly the state this script exists to
// prevent, and it would otherwise only surface at runtime in the deployed container.
if (unresolved.length > 0) {
  console.error(`could not resolve ${unresolved.length} catalog spec(s): ${unresolved.join(", ")}`);
  process.exit(1);
}

writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`resolved ${resolved.length} catalog spec(s): ${resolved.join(", ")}`);
