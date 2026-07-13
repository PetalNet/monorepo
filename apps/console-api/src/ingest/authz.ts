// Emit-authorization matrix (contract §4.3). The server never trusts an emission's source/scope/
// severity/type from the body alone: each is checked against the authenticated producer's
// registration. Reserved namespaces and op-completion types are default-deny by type-prefix, so a
// producer cannot forge audit/attention/p0 events or falsely close another executor's async op.

import type { Emission, Severity } from "../emission.ts";
import { SEVERITIES } from "../emission.ts";

export interface ProducerRegistration {
	/**
	 * The authenticated principal id this registration belongs to (e.g. system:control-plane,
	 * agent:janet, bridge:.15).
	 */
	readonly subject: string;
	/** Exact source.service values this producer may stamp. */
	readonly allowedServices: readonly string[];
	/**
	 * Allowed emission type prefixes (default-deny). A completion type is grantable to exactly one
	 * executor's bridge.
	 */
	readonly allowedTypePrefixes: readonly string[];
	/**
	 * Scope patterns: exact tags, `fleet`, or a family wildcard `agent:*` | `user:*` | `project:*` |
	 * `restricted:*`.
	 */
	readonly allowedScopes: readonly string[];
	/** Producer may not exceed this severity. */
	readonly maxSeverity: Severity;
}

function scopeAllowed(scope: string, patterns: readonly string[]): boolean {
	for (const p of patterns) {
		if (p === scope) return true;
		if (p.endsWith(":*")) {
			const fam = p.slice(0, -1); // "agent:"
			if (scope.startsWith(fam)) return true;
		}
	}
	return false;
}

function typeAllowed(type: string, prefixes: readonly string[]): boolean {
	for (const p of prefixes) {
		if (type === p) return true;
		if (p.endsWith(".*")) {
			if (type.startsWith(p.slice(0, -1))) return true; // "doorman." matches doorman.link.flap
		} else if (type.startsWith(`${p}.`)) return true; // bare namespace prefix
	}
	return false;
}

export interface AuthzResult {
	readonly ok: boolean;
	readonly code?: string;
	readonly message?: string;
}

export function authorizeEmission(reg: ProducerRegistration, e: Emission): AuthzResult {
	if (!reg.allowedServices.includes(e.source.service))
		return {
			ok: false,
			code: "source_mismatch",
			message: `service ${e.source.service} not permitted for ${reg.subject}`,
		};
	if (!typeAllowed(e.type, reg.allowedTypePrefixes))
		return {
			ok: false,
			code: "namespace_reserved",
			message: `type ${e.type} not permitted for ${reg.subject}`,
		};
	if (!scopeAllowed(e.scope, reg.allowedScopes))
		return {
			ok: false,
			code: "scope_denied",
			message: `scope ${e.scope} not permitted for ${reg.subject}`,
		};
	if (SEVERITIES.indexOf(e.severity) > SEVERITIES.indexOf(reg.maxSeverity))
		return {
			ok: false,
			code: "severity_denied",
			message: `severity ${e.severity} exceeds cap ${reg.maxSeverity}`,
		};
	return { ok: true };
}
