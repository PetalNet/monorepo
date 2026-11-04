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
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const checks = [];
const ok = (name) => checks.push({ name, pass: true });
const fail = (name, detail) => checks.push({ name, pass: false, detail });

// (a) the public share route exists and exports a GET handler.
const ROUTE = path.join(ROOT, "src/routes/s/[token]/+server.js");

if (existsSync(ROUTE)) {
	ok("public /s/[token] route file exists");
	const route = readFileSync(ROUTE, "utf8");
	// SvelteKit endpoint GET export, in any of the valid forms.
	const exportsGet =
		/export\s+(async\s+)?function\s+GET\b/.test(route) ||
		/export\s+const\s+GET\s*=/.test(route) ||
		/export\s*\{[^}]*\bGET\b[^}]*\}/.test(route);

	if (exportsGet) {
		ok("/s/[token]/+server.js exports a GET handler");
	} else {
		fail("/s/[token]/+server.js exports a GET handler", "no GET export found");
	}
} else {
	fail("public /s/[token] route file exists", `missing: ${ROUTE}`);
}

// (b) hooks.server.js keeps the public-share SSO exemption, applied BEFORE the gate.
const HOOKS = path.join(ROOT, "src/hooks.server.js");

if (existsSync(HOOKS)) {
	ok("src/hooks.server.js exists");
	const hooks = readFileSync(HOOKS, "utf8");

	// the exemption predicate is defined and keyed to the /s/ prefix.
	const hasPredicate = hooks.includes("isPublicShare") && /['"`]\/s\b/.test(hooks);

	if (hasPredicate) {
		ok("hooks defines an isPublicShare predicate scoped to /s/");
	} else {
		fail(
			"hooks defines an isPublicShare predicate scoped to /s/",
			"isPublicShare or /s/ prefix not found",
		);
	}

	// the Authentik gate must NEGATE the exemption — i.e. a /s/ request bypasses the 403.
	// Match the gate condition guarding the reject, tolerant of whitespace.
	const gateBypasses = /!\s*isPublicShare\s*\(/.test(hooks);

	if (gateBypasses) {
		ok("Authentik gate bypasses the 403 for public-share paths (!isPublicShare)");
	} else {
		fail(
			"Authentik gate bypasses the 403 for public-share paths (!isPublicShare)",
			"no `!isPublicShare(` guard on the gate",
		);
	}
} else {
	fail("src/hooks.server.js exists", `missing: ${HOOKS}`);
}

// report
let failed = 0;

for (const c of checks) {
	console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : ` — ${c.detail}`}`);

	if (!c.pass) {
		failed++;
	}
}

console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

if (failed) {
	console.error(
		"\nGuard FAILED: the public /s/ share route or its SSO exemption regressed (#502).",
	);

	process.exit(1);
}
