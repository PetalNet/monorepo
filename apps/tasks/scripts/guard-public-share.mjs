#!/usr/bin/env node
// Regression guard for the PUBLIC scoped-share route (#487) and its SSO exemption.
//
// A redesign once silently deleted BOTH the public `/s/[token]` share route and the
// `isPublicShare` bypass in hooks.server.js — these are in live public use (#502).
// This test fails the build the moment either disappears, so it can't regress unnoticed.
//
// No vitest in this project → a dependency-free node assertion script, wired to the
// `test:guards` pnpm script. CI-friendly: prints each check, exits 1 on any failure.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const ok = (name) => checks.push({ name, pass: true });
const fail = (name, detail) => checks.push({ name, pass: false, detail });

// (a) the public share route exists and exports a GET handler.
const ROUTE = join(ROOT, "src/routes/s/[token]/+server.js");
if (!existsSync(ROUTE)) {
	fail("public /s/[token] route file exists", `missing: ${ROUTE}`);
} else {
	ok("public /s/[token] route file exists");
	const route = readFileSync(ROUTE, "utf8");
	// SvelteKit endpoint GET export, in any of the valid forms.
	const exportsGet =
		/export\s+(async\s+)?function\s+GET\b/.test(route) ||
		/export\s+const\s+GET\s*=/.test(route) ||
		/export\s*\{[^}]*\bGET\b[^}]*\}/.test(route);
	exportsGet
		? ok("/s/[token]/+server.js exports a GET handler")
		: fail("/s/[token]/+server.js exports a GET handler", "no GET export found");
}

// (b) hooks.server.js keeps the public-share SSO exemption, applied BEFORE the gate.
const HOOKS = join(ROOT, "src/hooks.server.js");
if (!existsSync(HOOKS)) {
	fail("src/hooks.server.js exists", `missing: ${HOOKS}`);
} else {
	ok("src/hooks.server.js exists");
	const hooks = readFileSync(HOOKS, "utf8");

	// the exemption predicate is defined and keyed to the /s/ prefix.
	const hasPredicate = /isPublicShare/.test(hooks) && /['"`]\/s\b/.test(hooks);
	hasPredicate
		? ok("hooks defines an isPublicShare predicate scoped to /s/")
		: fail(
				"hooks defines an isPublicShare predicate scoped to /s/",
				"isPublicShare or /s/ prefix not found",
			);

	// the Authentik gate must NEGATE the exemption — i.e. a /s/ request bypasses the 403.
	// Match the gate condition guarding the reject, tolerant of whitespace.
	const gateBypasses = /!\s*isPublicShare\s*\(/.test(hooks);
	gateBypasses
		? ok("Authentik gate bypasses the 403 for public-share paths (!isPublicShare)")
		: fail(
				"Authentik gate bypasses the 403 for public-share paths (!isPublicShare)",
				"no `!isPublicShare(` guard on the gate",
			);
}

// report
let failed = 0;
for (const c of checks) {
	console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : ` — ${c.detail}`}`);
	if (!c.pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed) {
	console.error(
		"\nGuard FAILED: the public /s/ share route or its SSO exemption regressed (#502).",
	);
	process.exit(1);
}
