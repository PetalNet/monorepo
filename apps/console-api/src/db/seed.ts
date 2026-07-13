// Bootstrap seed (contract §7, PHASE1-DESIGN §7) — breaks the grant⇄token⇄mint chicken-and-egg.
// Idempotent: safe to run at every deploy. Inserts the baseline grants, producer registrations,
// and tier rows without which nothing can legally emit or be administered.

import type { Sql } from "./pool.ts";

interface GrantSeed {
	subject: string;
	relation: string;
	object: string;
}
interface RegSeed {
	subject: string;
	services: string[];
	prefixes: string[];
	scopes: string[];
	maxSeverity: string;
}

const TIERS: readonly {
	name: string;
	group: string | null;
	description: string;
	defaultRelations: string[];
	proposeOnly: boolean;
}[] = [
	{
		name: "owner",
		group: "owner",
		description: "Full administration of explicitly visible resources.",
		defaultRelations: ["owner"],
		proposeOnly: false,
	},
	{
		name: "moderator",
		group: "moderator",
		description: "Operate explicitly visible resources without changing ownership.",
		defaultRelations: ["operator"],
		proposeOnly: false,
	},
	{
		name: "collaborator",
		group: "collaborator",
		description: "View explicitly shared resources and propose changes for owner promotion.",
		defaultRelations: ["viewer"],
		proposeOnly: true,
	},
	{
		name: "guest",
		group: "guest",
		description: "No implicit access; every visible resource requires an explicit grant.",
		defaultRelations: [],
		proposeOnly: false,
	},
];

const GRANTS: readonly GrantSeed[] = [
	{ subject: "parker", relation: "owner", object: "fleet" },
	{ subject: "parker", relation: "owner", object: "user:parker" },
	{ subject: "eli", relation: "operator", object: "fleet" },
	{ subject: "eli", relation: "owner", object: "user:eli" },
	{ subject: "tier:owner", relation: "owner", object: "fleet" },
	{ subject: "tier:moderator", relation: "operator", object: "fleet" },
	{ subject: "system:console-api", relation: "editor", object: "fleet" },
	{ subject: "bridge:fleet", relation: "editor", object: "fleet" },
	{ subject: "bridge:manager", relation: "editor", object: "fleet" },
	{ subject: "bridge:dispatcher", relation: "editor", object: "fleet" },
	{ subject: "bridge:control-plane", relation: "editor", object: "fleet" },
	{ subject: "bridge:hosts", relation: "editor", object: "fleet" },
	{ subject: "bridge:box-agent", relation: "editor", object: "fleet" },
	{ subject: "bridge:doorman", relation: "editor", object: "fleet" },
	{ subject: "bridge:system-outbox", relation: "editor", object: "fleet" },
];

// Producer registrations: default-deny; each bridge/executor gets exactly the prefixes it may emit.
// Op-completion types (agent.lifecycle, service.lifecycle, ...) are grantable to ONE executor's
// bridge, so no producer can forge another executor's async completion (contract §4.3 rule 6).
const REGISTRATIONS: readonly RegSeed[] = [
	{
		subject: "system:console-api",
		services: ["console-api"],
		prefixes: [
			"console.api",
			"audit",
			"term",
			"attention",
			"subscription",
			"delivery",
			"signal",
			"lake",
			"bridge",
		],
		scopes: ["fleet", "user:*", "agent:*", "project:*", "restricted:*"],
		maxSeverity: "p0",
	},
	{
		subject: "bridge:fleet",
		services: ["bridge"],
		prefixes: ["bridge", "fleet.event"],
		scopes: ["fleet"],
		maxSeverity: "warn",
	},
	{
		subject: "bridge:manager",
		services: ["bridge", "manager"],
		prefixes: ["bridge", "agent.heartbeat", "agent.crashed", "agent.lifecycle", "channel"],
		scopes: ["fleet"],
		maxSeverity: "p0",
	},
	{
		subject: "bridge:dispatcher",
		services: ["bridge", "dispatcher"],
		prefixes: ["bridge", "card", "comms"],
		scopes: ["fleet"],
		maxSeverity: "danger",
	},
	{
		subject: "bridge:control-plane",
		services: ["bridge", "control-plane"],
		prefixes: ["bridge", "governance", "fleet.mode", "discipline", "usage"],
		scopes: ["fleet"],
		maxSeverity: "warn",
	},
	{
		subject: "bridge:hosts",
		services: ["bridge"],
		prefixes: ["bridge", "host", "container", "box", "service.lifecycle"],
		scopes: ["fleet"],
		maxSeverity: "p0",
	},
	{
		subject: "bridge:box-agent",
		services: ["bridge", "box-agent"],
		prefixes: ["bridge", "agent.capacity", "worker", "host", "container"],
		scopes: ["fleet"],
		maxSeverity: "danger",
	},
	{
		subject: "bridge:doorman",
		services: ["bridge", "doorman"],
		prefixes: ["bridge", "doorman"],
		scopes: ["fleet"],
		maxSeverity: "danger",
	},
	{
		subject: "bridge:system-outbox",
		services: ["bridge"],
		prefixes: ["bridge", "bot", "host", "container"],
		scopes: ["fleet"],
		maxSeverity: "danger",
	},
];

export async function seedBootstrap(admin: Sql): Promise<void> {
	for (const t of TIERS) {
		await admin`insert into tiers (name, authentik_group, description, default_relations, propose_only)
			values (${t.name}, ${t.group}, ${t.description}, ${admin.json(t.defaultRelations)}, ${t.proposeOnly})
			on conflict (name) do nothing`;
	}
	for (const g of GRANTS) {
		const exists =
			await admin`select 1 from grants where subject = ${g.subject} and relation = ${g.relation} and object = ${g.object} and invalid_at is null`;
		if (exists.length === 0)
			await admin`insert into grants (subject, relation, object, granted_by) values (${g.subject}, ${g.relation}, ${g.object}, 'seed')`;
	}
	for (const r of REGISTRATIONS) {
		await admin`insert into producer_registrations (subject, allowed_services, allowed_prefixes, allowed_scopes, max_severity)
			values (${r.subject}, ${admin.json(r.services)}, ${admin.json(r.prefixes)}, ${admin.json(r.scopes)}, ${r.maxSeverity})
			on conflict (subject) do update set
				allowed_services = excluded.allowed_services,
				allowed_prefixes = excluded.allowed_prefixes,
				allowed_scopes = excluded.allowed_scopes,
				max_severity = excluded.max_severity`;
	}
}
