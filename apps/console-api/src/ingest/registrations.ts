// Load a producer's emit registration (contract §4.3). Default-deny: a subject with no
// registration cannot emit anything.

import type { Sql } from "../db/pool.ts";
import type { Severity } from "../emission.ts";
import type { ProducerRegistration } from "./authz.ts";

interface RegRow {
	subject: string;
	allowed_services: string[];
	allowed_prefixes: string[];
	allowed_scopes: string[];
	max_severity: string;
}

const SEVS = new Set(["debug", "info", "warn", "danger", "p0"]);

export async function loadRegistration(
	sql: Sql,
	subject: string,
): Promise<ProducerRegistration | null> {
	const rows = await sql<RegRow[]>`
		select subject, allowed_services, allowed_prefixes, allowed_scopes, max_severity
		from producer_registrations where subject = ${subject}`;
	const r = rows[0];
	if (!r) return null;
	const maxSeverity: Severity = SEVS.has(r.max_severity) ? (r.max_severity as Severity) : "info";
	return {
		subject: r.subject,
		allowedServices: r.allowed_services,
		allowedTypePrefixes: r.allowed_prefixes,
		allowedScopes: r.allowed_scopes,
		maxSeverity,
	};
}
