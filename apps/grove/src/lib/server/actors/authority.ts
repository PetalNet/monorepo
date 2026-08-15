import * as PgClient from "@effect/sql-pg/PgClient";
import { Cause, Context, Effect, Layer } from "effect";

const SPROUT_CAPABILITIES = [
	"sprouts.list",
	"sprouts.get",
	"sprouts.create",
	"sprouts.water",
	"sprouts.remove",
] as const;
const isSproutCapability = (capability: string) =>
	(SPROUT_CAPABILITIES as readonly string[]).includes(capability);

export interface ExternalIdentity {
	readonly issuer: string;
	readonly subject: string;
}

export interface MachineIdentity extends ExternalIdentity {
	readonly scopes: ReadonlySet<string>;
}

export interface PersonPrincipal {
	readonly kind: "person";
	readonly actorId: string;
	readonly authUserId: string;
	readonly name: string;
}

export interface AgentPrincipal extends MachineIdentity {
	readonly kind: "agent";
	readonly actorId: string;
	readonly name: string;
	readonly homeHostId: string;
	readonly ownerPersonId: string;
}

export interface BootstrapPrincipal extends MachineIdentity {
	readonly kind: "bootstrap";
}

export interface UnboundMachinePrincipal extends MachineIdentity {
	readonly kind: "unbound";
}

export type MachinePrincipal = AgentPrincipal | BootstrapPrincipal | UnboundMachinePrincipal;
export type ActorPrincipal = PersonPrincipal | AgentPrincipal;

export class ActorDatabaseError extends Error {
	readonly _tag = "ActorDatabaseError";

	constructor(readonly cause: unknown) {
		super("Actor authority is unavailable", { cause });
	}
}

export class ActorNotCurrent extends Error {
	readonly _tag = "ActorNotCurrent";

	constructor(readonly actorId: string) {
		super(`Actor ${actorId} is not current`);
	}
}

export class ActorDenied extends Error {
	readonly _tag = "ActorDenied";
	readonly reason: string;

	constructor(reason: string) {
		super(reason);
		this.reason = reason;
	}
}

export class HomeOwnerUnbound extends Error {
	readonly _tag = "HomeOwnerUnbound";

	constructor(readonly configuredIdentity: ExternalIdentity) {
		super("The configured Home Host owner has not completed a verified browser login");
	}
}

export interface ContainmentConflict {
	readonly agentId: string;
	readonly personId: string;
	readonly missingCapabilities: readonly string[];
}

export interface ContainmentFix {
	readonly action: "grant-person-capability" | "remove-agent-access" | "remove-agent-capability";
	readonly agentId: string;
	readonly personId: string;
	readonly capability: string;
	readonly available: boolean;
	readonly reason?: string;
}

export class CapabilityContainmentConflict extends Error {
	readonly _tag = "CapabilityContainmentConflict";

	constructor(
		readonly conflicts: readonly ContainmentConflict[],
		readonly fixes: readonly ContainmentFix[],
	) {
		super("Agent capability containment would be violated");
	}
}

interface ActorAuthorityConfig {
	readonly homeOwner: ExternalIdentity;
}

interface BrowserIdentityInput extends ExternalIdentity {
	readonly authUserId: string;
	readonly name: string;
	readonly emailVerified: boolean;
}

type BrowserIdentityLookup = Pick<BrowserIdentityInput, "authUserId" | "issuer" | "subject">;

interface EnrollSelfInput {
	readonly name: string;
}

type HomeReadiness =
	| {
			readonly status: "owner-unbound";
			readonly configuredIdentity: ExternalIdentity;
	  }
	| {
			readonly status: "owner-config-mismatch";
			readonly configuredIdentity: ExternalIdentity;
			readonly ownerPersonId: string;
	  }
	| {
			readonly status: "owner-not-current";
			readonly ownerPersonId: string;
			readonly lifecycle: "dormant" | "suspended" | "retired";
	  }
	| { readonly status: "ready"; readonly ownerPersonId: string };

export type AuthorityError =
	| ActorDatabaseError
	| ActorDenied
	| ActorNotCurrent
	| HomeOwnerUnbound
	| CapabilityContainmentConflict;

interface ActorAuthorityShape {
	readonly homeReadiness: Effect.Effect<HomeReadiness, AuthorityError>;
	readonly lookupBrowserIdentity: (
		input: BrowserIdentityLookup,
	) => Effect.Effect<PersonPrincipal | null, AuthorityError>;
	readonly bindBrowserIdentity: (
		input: BrowserIdentityInput,
	) => Effect.Effect<PersonPrincipal, AuthorityError>;
	readonly resolveMachineIdentity: (
		identity: MachineIdentity,
	) => Effect.Effect<MachinePrincipal, AuthorityError>;
	readonly enrollSelf: (
		identity: MachineIdentity,
		input: EnrollSelfInput,
	) => Effect.Effect<AgentPrincipal, AuthorityError>;
	readonly authorizeActor: (
		principal: ActorPrincipal,
		operation: string,
	) => Effect.Effect<void, AuthorityError>;
	readonly authorizedOperations: (
		principal: MachinePrincipal,
	) => Effect.Effect<readonly string[], AuthorityError>;
	readonly grantAgentAccessAs: (
		principal: PersonPrincipal,
		agentId: string,
		personId: string,
	) => Effect.Effect<void, AuthorityError>;
	readonly requestAgentCapability: (
		principal: PersonPrincipal,
		agentId: string,
		capability: string,
	) => Effect.Effect<void, AuthorityError>;
	readonly removePersonCapabilityAs: (
		principal: PersonPrincipal,
		personId: string,
		capability: string,
	) => Effect.Effect<void, AuthorityError>;
	readonly applyContainmentFixAs: (
		principal: PersonPrincipal,
		fix: Omit<ContainmentFix, "available" | "reason">,
	) => Effect.Effect<void, AuthorityError>;
	readonly suspendAgentAs: (
		principal: PersonPrincipal,
		agentId: string,
	) => Effect.Effect<void, AuthorityError>;
	readonly retireAgentAs: (
		principal: PersonPrincipal,
		agentId: string,
	) => Effect.Effect<void, AuthorityError>;
}

export class ActorAuthority extends Context.Service<ActorAuthority, ActorAuthorityShape>()(
	"grove/ActorAuthority",
) {}

const unavailableDuringBuild = () => Effect.die("Actor authority is unavailable during build");

export const ActorAuthorityBuildLayer = Layer.succeed(ActorAuthority, {
	homeReadiness: unavailableDuringBuild(),
	lookupBrowserIdentity: unavailableDuringBuild,
	bindBrowserIdentity: unavailableDuringBuild,
	resolveMachineIdentity: unavailableDuringBuild,
	enrollSelf: unavailableDuringBuild,
	authorizeActor: unavailableDuringBuild,
	authorizedOperations: unavailableDuringBuild,
	grantAgentAccessAs: unavailableDuringBuild,
	requestAgentCapability: unavailableDuringBuild,
	removePersonCapabilityAs: unavailableDuringBuild,
	applyContainmentFixAs: unavailableDuringBuild,
	suspendAgentAs: unavailableDuringBuild,
	retireAgentAs: unavailableDuringBuild,
});

interface ActorRow {
	readonly actor_id: string;
	readonly kind: "person" | "agent";
	readonly name: string;
	readonly lifecycle: "active" | "dormant" | "suspended" | "retired";
	readonly auth_user_id: string | null;
	readonly identity_use: "browser" | "machine";
	readonly home_host_id: string | null;
	readonly owner_person_id: string | null;
}

interface CapabilityRow {
	readonly capability: string;
}

interface PersonCapabilityRow {
	readonly person_id: string;
	readonly capability: string | null;
	readonly is_owner: boolean;
}

const personId = () => `person-${crypto.randomUUID()}`;
const agentId = () => `agent-${crypto.randomUUID()}`;
const normalizedName = (name: string) => {
	const value = name.trim();
	return value.length > 0 && value.length <= 80 ? value : undefined;
};
const isOwnerIdentity = (configured: ExternalIdentity, candidate: ExternalIdentity) =>
	configured.issuer === candidate.issuer && configured.subject === candidate.subject;
const isAuthorityError = (error: unknown): error is AuthorityError =>
	error instanceof ActorDatabaseError ||
	error instanceof ActorDenied ||
	error instanceof ActorNotCurrent ||
	error instanceof HomeOwnerUnbound ||
	error instanceof CapabilityContainmentConflict;
const asDatabaseError = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, AuthorityError> =>
	effect.pipe(
		Effect.catchCause((cause) => {
			const failures = cause.reasons.filter(Cause.isFailReason);
			const error = failures.length === 1 ? failures[0]?.error : undefined;
			return Effect.fail(isAuthorityError(error) ? error : new ActorDatabaseError(cause));
		}),
	);

const conflictFor = (
	agentIdValue: string,
	personIdValue: string,
	capabilities: readonly string[],
	isOwner: boolean,
) =>
	new CapabilityContainmentConflict(
		[
			{
				agentId: agentIdValue,
				personId: personIdValue,
				missingCapabilities: capabilities,
			},
		],
		capabilities.flatMap((capability): readonly ContainmentFix[] => [
			{
				action: "grant-person-capability",
				agentId: agentIdValue,
				personId: personIdValue,
				capability,
				available: true,
			},
			{
				action: "remove-agent-access",
				agentId: agentIdValue,
				personId: personIdValue,
				capability,
				available: !isOwner,
				...(isOwner ? { reason: "A Home Host owner cannot lose access to a hosted Agent" } : {}),
			},
			{
				action: "remove-agent-capability",
				agentId: agentIdValue,
				personId: personIdValue,
				capability,
				available: true,
			},
		]),
	);

export const ActorAuthorityLayer = (config: ActorAuthorityConfig) =>
	Layer.effect(
		ActorAuthority,
		Effect.map(PgClient.PgClient, (sql): ActorAuthorityShape => {
			const actorForIdentity = (identity: ExternalIdentity) =>
				sql.unsafe<ActorRow>(
					`select a.id as actor_id, a.kind, a.name, a.lifecycle,
                p.better_auth_user_id as auth_user_id, i.use as identity_use,
                g.home_host_id, g.owner_person_id
           from grove_external_identities i
           join grove_actors a on a.id = i.actor_id
           left join grove_persons p on p.actor_id = a.id
           left join grove_agents g on g.actor_id = a.id
          where i.issuer = $1 and i.subject = $2`,
					[identity.issuer, identity.subject],
				);
			const lockExternalIdentity = (identity: ExternalIdentity) =>
				sql
					.unsafe("select pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
						identity.issuer,
						identity.subject,
					])
					.pipe(Effect.asVoid);
			const capabilitiesFor = (actorIdValue: string) =>
				sql.unsafe<CapabilityRow>(
					"select capability from grove_actor_capabilities where actor_id = $1 order by capability",
					[actorIdValue],
				);
			const insertDefaultCapabilities = (actorIdValue: string) =>
				Effect.forEach(SPROUT_CAPABILITIES, (capability) =>
					sql.unsafe(
						"insert into grove_actor_capabilities (actor_id, capability) values ($1, $2) on conflict do nothing",
						[actorIdValue, capability],
					),
				).pipe(Effect.asVoid);
			const serializeContainment = <A, E>(effect: Effect.Effect<A, E>) =>
				asDatabaseError(
					sql.withTransaction(
						sql
							.unsafe("select pg_advisory_xact_lock(hashtext('grove-capability-containment'))")
							.pipe(Effect.andThen(effect)),
					),
				);
			const homeReadiness = asDatabaseError(
				sql
					.unsafe<{
						owner_person_id: string | null;
						owner_lifecycle: "active" | "dormant" | "suspended" | "retired" | null;
						configured_owner: boolean;
					}>(
						`select h.owner_person_id, a.lifecycle as owner_lifecycle,
                  exists (
                    select 1
                      from grove_external_identities i
                     where i.actor_id = h.owner_person_id
                       and i.issuer = $1 and i.subject = $2 and i.use = 'browser'
                  ) as configured_owner
             from grove_hosts h
             left join grove_actors a on a.id = h.owner_person_id
            where h.id = 'host-local'`,
						[config.homeOwner.issuer, config.homeOwner.subject],
					)
					.pipe(
						Effect.map((rows): HomeReadiness => {
							const row = rows.at(0);
							if (!row?.owner_person_id)
								return { status: "owner-unbound", configuredIdentity: config.homeOwner };
							if (!row.configured_owner)
								return {
									status: "owner-config-mismatch",
									configuredIdentity: config.homeOwner,
									ownerPersonId: row.owner_person_id,
								};
							if (row.owner_lifecycle !== "active")
								return {
									status: "owner-not-current",
									ownerPersonId: row.owner_person_id,
									lifecycle: row.owner_lifecycle ?? "retired",
								};
							return { status: "ready", ownerPersonId: row.owner_person_id };
						}),
					),
			);
			const lookupBrowserIdentity = (input: BrowserIdentityLookup) =>
				asDatabaseError(
					actorForIdentity(input).pipe(
						Effect.map((rows): PersonPrincipal | null => {
							const actor = rows.at(0);
							if (
								actor?.kind !== "person" ||
								actor.identity_use !== "browser" ||
								actor.auth_user_id !== input.authUserId ||
								actor.lifecycle !== "active"
							)
								return null;
							return {
								kind: "person",
								actorId: actor.actor_id,
								authUserId: input.authUserId,
								name: actor.name,
							};
						}),
					),
				);
			const bindBrowserIdentity = (input: BrowserIdentityInput) => {
				if (!input.emailVerified)
					return Effect.fail(new ActorDenied("A verified browser email is required"));
				const name = normalizedName(input.name);
				if (!name)
					return Effect.fail(new ActorDenied("Person name must be between 1 and 80 characters"));
				return asDatabaseError(
					sql.withTransaction(
						Effect.gen(function* () {
							yield* lockExternalIdentity(input);
							const existing = (yield* actorForIdentity(input)).at(0);
							let actorIdValue: string;
							if (existing) {
								if (
									existing.kind !== "person" ||
									existing.identity_use !== "browser" ||
									existing.auth_user_id !== input.authUserId
								)
									return yield* Effect.fail(
										new ActorDenied("The browser identity is already bound to another actor"),
									);
								actorIdValue = existing.actor_id;
								yield* sql.unsafe(
									"update grove_actors set name = $2, updated_at = now() where id = $1",
									[actorIdValue, name],
								);
							} else {
								const byAuthUser = yield* sql.unsafe<{ actor_id: string }>(
									"select actor_id from grove_persons where better_auth_user_id = $1",
									[input.authUserId],
								);
								if (byAuthUser.length > 0)
									return yield* Effect.fail(
										new ActorDenied("The browser account is already bound to another identity"),
									);
								actorIdValue = personId();
								yield* sql.unsafe(
									"insert into grove_actors (id, kind, name) values ($1, 'person', $2)",
									[actorIdValue, name],
								);
								yield* sql.unsafe(
									"insert into grove_persons (actor_id, better_auth_user_id) values ($1, $2)",
									[actorIdValue, input.authUserId],
								);
								yield* sql.unsafe(
									"insert into grove_external_identities (actor_id, issuer, subject, use) values ($1, $2, $3, 'browser')",
									[actorIdValue, input.issuer, input.subject],
								);
								yield* insertDefaultCapabilities(actorIdValue);
							}

							if (isOwnerIdentity(config.homeOwner, input)) {
								yield* sql.unsafe(
									"update grove_hosts set owner_person_id = $1 where id = 'host-local' and owner_person_id is null",
									[actorIdValue],
								);
								const host = yield* sql.unsafe<{ owner_person_id: string | null }>(
									"select owner_person_id from grove_hosts where id = 'host-local'",
								);
								if (host.at(0)?.owner_person_id !== actorIdValue)
									return yield* Effect.fail(
										new ActorDenied("The local Home Host is already owned by another Person"),
									);
							}

							return {
								kind: "person" as const,
								actorId: actorIdValue,
								authUserId: input.authUserId,
								name,
							};
						}),
					),
				);
			};
			const resolveMachineIdentity = (identity: MachineIdentity) =>
				asDatabaseError(
					actorForIdentity(identity).pipe(
						Effect.flatMap((rows): Effect.Effect<MachinePrincipal, ActorDenied> => {
							const actor = rows.at(0);
							if (!actor)
								return Effect.succeed(
									identity.scopes.has("grove:agent:enroll")
										? { ...identity, kind: "bootstrap" }
										: { ...identity, kind: "unbound" },
								);
							if (
								actor.kind !== "agent" ||
								actor.identity_use !== "machine" ||
								!actor.home_host_id ||
								!actor.owner_person_id
							)
								return Effect.fail(
									new ActorDenied("The machine identity is bound to a non-Agent actor"),
								);
							return Effect.succeed({
								...identity,
								kind: "agent",
								actorId: actor.actor_id,
								name: actor.name,
								homeHostId: actor.home_host_id,
								ownerPersonId: actor.owner_person_id,
							});
						}),
					),
				);
			const enrollSelf = (identity: MachineIdentity, input: EnrollSelfInput) => {
				if (!identity.scopes.has("grove:agent:enroll"))
					return Effect.fail(new ActorDenied("Agent enrollment scope is required"));
				const name = normalizedName(input.name);
				if (!name)
					return Effect.fail(new ActorDenied("Agent name must be between 1 and 80 characters"));
				return asDatabaseError(
					sql.withTransaction(
						Effect.gen(function* () {
							yield* lockExternalIdentity(identity);
							yield* sql.unsafe(
								"select pg_advisory_xact_lock(hashtext('grove-capability-containment'))",
							);
							const existing = (yield* actorForIdentity(identity)).at(0);
							if (existing) {
								if (
									existing.kind !== "agent" ||
									existing.identity_use !== "machine" ||
									!existing.home_host_id ||
									!existing.owner_person_id
								)
									return yield* Effect.fail(
										new ActorDenied("The external identity is already bound to another actor"),
									);
								const principal = {
									...identity,
									kind: "agent" as const,
									actorId: existing.actor_id,
									name: existing.name,
									homeHostId: existing.home_host_id,
									ownerPersonId: existing.owner_person_id,
								};
								const current = yield* sql.unsafe<{
									agent_lifecycle: string;
									owner_lifecycle: string;
									host_owner_id: string | null;
								}>(
									`select agent_actor.lifecycle as agent_lifecycle,
                        owner_actor.lifecycle as owner_lifecycle,
                        h.owner_person_id as host_owner_id
                   from grove_agents g
                   join grove_actors agent_actor on agent_actor.id = g.actor_id
                   join grove_actors owner_actor on owner_actor.id = g.owner_person_id
                   join grove_hosts h on h.id = g.home_host_id
                  where g.actor_id = $1`,
									[existing.actor_id],
								);
								const row = current.at(0);
								if (
									row?.agent_lifecycle !== "active" ||
									row.owner_lifecycle !== "active" ||
									row.host_owner_id !== existing.owner_person_id
								)
									return yield* Effect.fail(new ActorNotCurrent(existing.actor_id));
								return principal;
							}
							const host = yield* sql.unsafe<{
								owner_person_id: string | null;
								owner_lifecycle: string | null;
							}>(
								`select h.owner_person_id, a.lifecycle as owner_lifecycle
                   from grove_hosts h
                   left join grove_actors a on a.id = h.owner_person_id
                  where h.id = 'host-local'
                  for update of h`,
							);
							const owner = host.at(0);
							if (!owner?.owner_person_id)
								return yield* Effect.fail(new HomeOwnerUnbound(config.homeOwner));
							if (owner.owner_lifecycle !== "active")
								return yield* Effect.fail(new ActorDenied("The Home Host owner is not active"));

							const actorIdValue = agentId();
							yield* sql.unsafe(
								"insert into grove_actors (id, kind, name) values ($1, 'agent', $2)",
								[actorIdValue, name],
							);
							yield* sql.unsafe(
								"insert into grove_agents (actor_id, home_host_id, owner_person_id) values ($1, 'host-local', $2)",
								[actorIdValue, owner.owner_person_id],
							);
							yield* sql.unsafe(
								"insert into grove_external_identities (actor_id, issuer, subject, use) values ($1, $2, $3, 'machine')",
								[actorIdValue, identity.issuer, identity.subject],
							);
							yield* insertDefaultCapabilities(actorIdValue);
							return {
								...identity,
								kind: "agent" as const,
								actorId: actorIdValue,
								name,
								homeHostId: "host-local",
								ownerPersonId: owner.owner_person_id,
							};
						}),
					),
				);
			};
			const authorizeActor = (principal: ActorPrincipal, operation: string) =>
				asDatabaseError(
					Effect.gen(function* () {
						if (principal.kind === "person") {
							const rows = yield* sql.unsafe<{ lifecycle: string }>(
								`select a.lifecycle
                   from grove_actors a
                   join grove_persons p on p.actor_id = a.id
                  where a.id = $1 and p.better_auth_user_id = $2
                    for share of a`,
								[principal.actorId, principal.authUserId],
							);
							const row = rows.at(0);
							if (row?.lifecycle !== "active")
								return yield* Effect.fail(new ActorNotCurrent(principal.actorId));
							const capabilities = yield* sql.unsafe<CapabilityRow>(
								`select capability
                   from grove_actor_capabilities
                  where actor_id = $1 and capability = $2
                    for share`,
								[principal.actorId, operation],
							);
							if (capabilities.length === 0)
								return yield* Effect.fail(new ActorDenied(`Actor lacks ${operation}`));
							return;
						}

						const rows = yield* sql.unsafe<{
							agent_lifecycle: string;
							owner_lifecycle: string;
							host_owner_id: string | null;
						}>(
							`select agent_actor.lifecycle as agent_lifecycle,
                        owner_actor.lifecycle as owner_lifecycle,
                        h.owner_person_id as host_owner_id
                   from grove_external_identities i
                   join grove_agents g on g.actor_id = i.actor_id
                   join grove_actors agent_actor on agent_actor.id = g.actor_id
                   join grove_actors owner_actor on owner_actor.id = g.owner_person_id
                   join grove_hosts h on h.id = g.home_host_id
                  where i.actor_id = $1 and i.issuer = $2 and i.subject = $3 and i.use = 'machine'
                    for share of agent_actor, owner_actor, h`,
							[principal.actorId, principal.issuer, principal.subject],
						);
						const row = rows.at(0);
						if (
							row?.agent_lifecycle !== "active" ||
							row.owner_lifecycle !== "active" ||
							row.host_owner_id !== principal.ownerPersonId
						)
							return yield* Effect.fail(new ActorNotCurrent(principal.actorId));
						const capabilities = yield* sql.unsafe<CapabilityRow>(
							`select capability
                   from grove_actor_capabilities
                  where actor_id = $1 and capability = $2
                    for share`,
							[principal.actorId, operation],
						);
						if (capabilities.length === 0)
							return yield* Effect.fail(new ActorDenied(`Actor lacks ${operation}`));
					}),
				);
			const authorizedOperations = (principal: MachinePrincipal) => {
				if (principal.kind === "bootstrap") return Effect.succeed(["agents.enrollSelf"]);
				if (principal.kind === "unbound") return Effect.succeed([]);
				return asDatabaseError(
					sql.withTransaction(
						authorizeActor(principal, "sprouts.list").pipe(
							Effect.andThen(capabilitiesFor(principal.actorId)),
							Effect.map((rows) => rows.map((row) => row.capability)),
						),
					),
				).pipe(
					Effect.catchIf(
						(error): error is ActorNotCurrent | ActorDenied =>
							error instanceof ActorNotCurrent || error instanceof ActorDenied,
						() => Effect.succeed([]),
					),
				);
			};
			const allowedPersons = (agentIdValue: string) =>
				sql.unsafe<PersonCapabilityRow>(
					`select g.owner_person_id as person_id, c.capability, true as is_owner
               from grove_agents g
			   join grove_actors agent_actor on agent_actor.id = g.actor_id and agent_actor.lifecycle = 'active'
			   join grove_actors owner_actor on owner_actor.id = g.owner_person_id and owner_actor.lifecycle = 'active'
			   join grove_hosts h on h.id = g.home_host_id and h.owner_person_id = g.owner_person_id
               left join grove_actor_capabilities c on c.actor_id = g.owner_person_id
              where g.actor_id = $1
              union all
             select aa.person_id, c.capability, false as is_owner
               from grove_agent_access aa
			   join grove_actors agent_actor on agent_actor.id = aa.agent_id and agent_actor.lifecycle = 'active'
			   join grove_actors person_actor on person_actor.id = aa.person_id and person_actor.lifecycle = 'active'
               left join grove_actor_capabilities c on c.actor_id = aa.person_id
              where aa.agent_id = $1 and aa.valid`,
					[agentIdValue],
				);
			const grantAgentAccess = (agentIdValue: string, personIdValue: string) =>
				Effect.gen(function* () {
					const agent = yield* sql.unsafe<{
						agent_lifecycle: string;
						owner_lifecycle: string;
						owner_person_id: string;
						host_owner_id: string | null;
					}>(
						`select agent_actor.lifecycle as agent_lifecycle,
                        owner_actor.lifecycle as owner_lifecycle,
                        g.owner_person_id,
                        h.owner_person_id as host_owner_id
                   from grove_agents g
                   join grove_actors agent_actor on agent_actor.id = g.actor_id
                   join grove_actors owner_actor on owner_actor.id = g.owner_person_id
                   join grove_hosts h on h.id = g.home_host_id
                  where g.actor_id = $1`,
						[agentIdValue],
					);
					const currentAgent = agent.at(0);
					if (
						currentAgent?.agent_lifecycle !== "active" ||
						currentAgent.owner_lifecycle !== "active" ||
						currentAgent.owner_person_id !== currentAgent.host_owner_id
					)
						return yield* Effect.fail(new ActorNotCurrent(agentIdValue));
					const person = yield* sql.unsafe<{ lifecycle: string }>(
						`select a.lifecycle
                   from grove_actors a
                   join grove_persons p on p.actor_id = a.id
                  where a.id = $1`,
						[personIdValue],
					);
					if (person.at(0)?.lifecycle !== "active")
						return yield* Effect.fail(new ActorNotCurrent(personIdValue));
					const agentCapabilities = (yield* capabilitiesFor(agentIdValue)).map(
						(row) => row.capability,
					);
					const personCapabilities = new Set(
						(yield* sql.unsafe<CapabilityRow>(
							`select c.capability
                         from grove_actor_capabilities c
                         join grove_actors a on a.id = c.actor_id and a.lifecycle = 'active'
                         join grove_persons p on p.actor_id = a.id
                        where c.actor_id = $1`,
							[personIdValue],
						)).map((row) => row.capability),
					);
					const missing = agentCapabilities.filter(
						(capability) => !personCapabilities.has(capability),
					);
					if (missing.length > 0)
						return yield* Effect.fail(conflictFor(agentIdValue, personIdValue, missing, false));
					yield* sql.unsafe(
						`insert into grove_agent_access (agent_id, person_id)
                 values ($1, $2)
                 on conflict (agent_id, person_id) do update
                 set valid = true, invalid_reason = null, updated_at = now()`,
						[agentIdValue, personIdValue],
					);
				});
			const addAgentCapability = (agentIdValue: string, capability: string) =>
				Effect.gen(function* () {
					const rows = yield* allowedPersons(agentIdValue);
					const grouped = new Map<string, { capabilities: Set<string>; isOwner: boolean }>();
					for (const row of rows) {
						const person = grouped.get(row.person_id) ?? {
							capabilities: new Set<string>(),
							isOwner: row.is_owner,
						};
						if (row.capability) person.capabilities.add(row.capability);
						grouped.set(row.person_id, person);
					}
					if (grouped.size === 0) return yield* Effect.fail(new ActorNotCurrent(agentIdValue));
					const conflicts = [...grouped].filter(
						([, person]) => !person.capabilities.has(capability),
					);
					if (conflicts.length > 0) {
						const errors = conflicts.map(([personIdValue, person]) =>
							conflictFor(agentIdValue, personIdValue, [capability], person.isOwner),
						);
						return yield* Effect.fail(
							new CapabilityContainmentConflict(
								errors.flatMap((error) => error.conflicts),
								errors.flatMap((error) => error.fixes),
							),
						);
					}
					yield* sql.unsafe(
						"insert into grove_actor_capabilities (actor_id, capability) values ($1, $2) on conflict do nothing",
						[agentIdValue, capability],
					);
				});
			const removePersonCapability = (personIdValue: string, capability: string) => {
				if (isSproutCapability(capability))
					return Effect.fail(
						new ActorDenied("Sprout compatibility capabilities apply to every active actor"),
					);
				return serializeContainment(
					Effect.gen(function* () {
						const rows = yield* sql.unsafe<{ agent_id: string; is_owner: boolean }>(
							`select g.actor_id as agent_id, true as is_owner
                   from grove_agents g
				   join grove_actors a on a.id = g.actor_id and a.lifecycle = 'active'
                   join grove_actor_capabilities c on c.actor_id = g.actor_id and c.capability = $2
                  where g.owner_person_id = $1
                  union all
                 select aa.agent_id, false as is_owner
                   from grove_agent_access aa
				   join grove_actors a on a.id = aa.agent_id and a.lifecycle = 'active'
                   join grove_actor_capabilities c on c.actor_id = aa.agent_id and c.capability = $2
                  where aa.person_id = $1 and aa.valid`,
							[personIdValue, capability],
						);
						if (rows.length > 0) {
							const errors = rows.map((row) =>
								conflictFor(row.agent_id, personIdValue, [capability], row.is_owner),
							);
							return yield* Effect.fail(
								new CapabilityContainmentConflict(
									errors.flatMap((error) => error.conflicts),
									errors.flatMap((error) => error.fixes),
								),
							);
						}
						yield* sql.unsafe(
							"delete from grove_actor_capabilities where actor_id = $1 and capability = $2",
							[personIdValue, capability],
						);
					}),
				);
			};
			const applyContainmentFix = (fix: Omit<ContainmentFix, "available" | "reason">) => {
				switch (fix.action) {
					case "grant-person-capability":
						return Effect.gen(function* () {
							const relationship = yield* sql.unsafe<{ allowed: boolean }>(
								`select true as allowed
                       from grove_agents g
                      where g.actor_id = $1 and g.owner_person_id = $2
                      union all
                     select true as allowed
                       from grove_agent_access aa
                      where aa.agent_id = $1 and aa.person_id = $2 and aa.valid`,
								[fix.agentId, fix.personId],
							);
							if (relationship.length === 0)
								return yield* Effect.fail(
									new ActorDenied("The Person does not have access to this Agent"),
								);
							yield* sql.unsafe(
								"insert into grove_actor_capabilities (actor_id, capability) values ($1, $2) on conflict do nothing",
								[fix.personId, fix.capability],
							);
						});
					case "remove-agent-access":
						return Effect.gen(function* () {
							const owner = yield* sql.unsafe<{ owner_person_id: string }>(
								"select owner_person_id from grove_agents where actor_id = $1",
								[fix.agentId],
							);
							if (owner.at(0)?.owner_person_id === fix.personId)
								return yield* Effect.fail(
									new ActorDenied("A Home Host owner cannot lose access to a hosted Agent"),
								);
							yield* sql.unsafe(
								`update grove_agent_access
                         set valid = false, invalid_reason = 'removed-by-explicit-fix', updated_at = now()
                       where agent_id = $1 and person_id = $2`,
								[fix.agentId, fix.personId],
							);
						});
					case "remove-agent-capability":
						if (isSproutCapability(fix.capability))
							return Effect.fail(
								new ActorDenied("Sprout compatibility capabilities apply to every active actor"),
							);
						return sql
							.unsafe(
								"delete from grove_actor_capabilities where actor_id = $1 and capability = $2",
								[fix.agentId, fix.capability],
							)
							.pipe(Effect.asVoid);
				}
			};
			const requireAgentManager = (
				principal: PersonPrincipal,
				agentIdValue: string,
				requireCurrentAgent: boolean,
			) =>
				sql
					.unsafe<{ owner_person_id: string }>(
						`select g.owner_person_id
                 from grove_agents g
                 join grove_hosts h
                   on h.id = g.home_host_id and h.owner_person_id = g.owner_person_id
                 join grove_persons p on p.actor_id = g.owner_person_id
				 join grove_actors manager_actor
				   on manager_actor.id = p.actor_id and manager_actor.lifecycle = 'active'
				 join grove_actors agent_actor on agent_actor.id = g.actor_id
				where g.actor_id = $1 and g.owner_person_id = $2 and p.better_auth_user_id = $3
				  and (not $4 or agent_actor.lifecycle = 'active')
				  for share of g, h, manager_actor, agent_actor`,
						[agentIdValue, principal.actorId, principal.authUserId, requireCurrentAgent],
					)
					.pipe(
						Effect.flatMap((rows) =>
							rows.length === 1
								? Effect.void
								: Effect.fail(new ActorDenied("Only the Home Host owner may manage this Agent")),
						),
					);
			const authorizedAgentMutation = <A, E>(
				principal: PersonPrincipal,
				agentIdValue: string,
				mutation: Effect.Effect<A, E>,
				requireCurrentAgent = true,
			) =>
				serializeContainment(
					requireAgentManager(principal, agentIdValue, requireCurrentAgent).pipe(
						Effect.andThen(mutation),
					),
				);
			const setLifecycle = (actorIdValue: string, lifecycle: "suspended" | "retired") =>
				Effect.gen(function* () {
					const actors = yield* sql.unsafe<{ lifecycle: string }>(
						"select lifecycle from grove_actors where id = $1 for update",
						[actorIdValue],
					);
					const current = actors.at(0)?.lifecycle;
					if (!current) return yield* Effect.fail(new ActorNotCurrent(actorIdValue));
					if (current === "retired" && lifecycle !== "retired")
						return yield* Effect.fail(new ActorDenied("A retired Actor cannot change lifecycle"));
					yield* sql.unsafe(
						"update grove_actors set lifecycle = $2, updated_at = now() where id = $1",
						[actorIdValue, lifecycle],
					);
					yield* sql.unsafe(
						`update grove_agent_access
                     set valid = false, invalid_reason = $2, updated_at = now()
                   where valid and (
                     agent_id = $1 or person_id = $1 or
                     agent_id in (select actor_id from grove_agents where owner_person_id = $1)
                   )`,
						[actorIdValue, `actor-${lifecycle}`],
					);
				});
			const setAgentLifecycleAs = (
				principal: PersonPrincipal,
				agentIdValue: string,
				lifecycle: "suspended" | "retired",
			) =>
				authorizedAgentMutation(
					principal,
					agentIdValue,
					setLifecycle(agentIdValue, lifecycle),
					false,
				);

			return {
				homeReadiness,
				lookupBrowserIdentity,
				bindBrowserIdentity,
				resolveMachineIdentity,
				enrollSelf,
				authorizeActor,
				authorizedOperations,
				grantAgentAccessAs: (principal, agentIdValue, personIdValue) =>
					authorizedAgentMutation(
						principal,
						agentIdValue,
						grantAgentAccess(agentIdValue, personIdValue),
					),
				requestAgentCapability: (principal, agentIdValue, capability) =>
					authorizedAgentMutation(
						principal,
						agentIdValue,
						addAgentCapability(agentIdValue, capability),
					),
				removePersonCapabilityAs: (principal, personIdValue, capability) =>
					personIdValue === principal.actorId
						? removePersonCapability(personIdValue, capability)
						: Effect.fail(new ActorDenied("A Person may reduce only their own capabilities")),
				applyContainmentFixAs: (principal, fix) =>
					authorizedAgentMutation(principal, fix.agentId, applyContainmentFix(fix)),
				suspendAgentAs: (principal, agentIdValue) =>
					setAgentLifecycleAs(principal, agentIdValue, "suspended"),
				retireAgentAs: (principal, agentIdValue) =>
					setAgentLifecycleAs(principal, agentIdValue, "retired"),
			};
		}),
	);
