import * as PgClient from "@effect/sql-pg/PgClient";
import { Cause, Context, Data, Effect, Layer, Schema } from "effect";
import { Fragment, Query, Table, Type } from "effect-qb";
import * as Pg from "effect-qb/postgres";
import * as SqlClient from "effect/sql/SqlClient";

import {
	actors as actorWrites,
	persons,
	agents,
	access as accessWrites,
	actorFields,
	identityFields,
	hostFields,
	capabilityFields,
	accessFields,
} from "../db/tables";

const Q = { ...Query, ...Pg.Query };
// effect-qb's public set operators accept portable sources only. These projections
// reuse the canonical column definitions, rather than maintaining mirrored schemas.
const withoutTimestamps = <T extends { created_at: unknown; updated_at?: unknown }>(fields: T) => {
	const { created_at: _createdAt, updated_at: _updatedAt, ...portable } = fields;
	return portable;
};
const actors = Table.make("grove_actors", withoutTimestamps(actorFields));
const identities = Table.make("grove_external_identities", withoutTimestamps(identityFields));
const hosts = Table.make("grove_hosts", withoutTimestamps(hostFields));
const capabilitiesTable = Table.make(
	"grove_actor_capabilities",
	withoutTimestamps(capabilityFields),
);
const capabilities = capabilitiesTable.pipe(
	Table.primaryKey(() => [capabilitiesTable.actor_id, capabilitiesTable.capability] as const),
);
const accessTable = Table.make("grove_agent_access", withoutTimestamps(accessFields));
const access = accessTable.pipe(
	Table.primaryKey(() => [accessTable.agent_id, accessTable.person_id] as const),
);
const agentActor = Table.alias(actors, "agent_actor");
const ownerActor = Table.alias(actors, "owner_actor");
const personActor = Table.alias(actors, "person_actor");
const managerActor = Table.alias(actors, "manager_actor");

// PostgreSQL void functions return an empty string. Function.call in 0.24.1
// returns Scalar.Any, so use the typed scalar-expression API for these overloads.
const advisoryLockExpression = Fragment.expression({
	dbType: Type.text(),
	schema: Schema.String,
	nullability: "never",
});
// Set operands in 0.24.1 require identical expression shapes, not merely identical
// result types. Reproject through common derived aliases, with explicit scalar
// contracts so the left join's nullability and both boolean values survive decoding.
const nullableCapabilityExpression = Fragment.expression({
	dbType: Type.text(),
	schema: Schema.NullOr(Schema.String),
	nullability: "maybe",
});
const booleanExpression = Fragment.expression({
	dbType: Type.boolean(),
	schema: Schema.Boolean,
	nullability: "never",
});
const ownerFlag = booleanExpression`true`;
const guestFlag = booleanExpression`false`;

// effect-qb 0.24.1 models lock strength but not PostgreSQL's OF targets. Extend only
// that renderer clause; selections, joins, predicates and parameters remain typed plans.
const executorWithLockTargets = (...targets: readonly string[]) => {
	const renderer = Pg.Renderer.make();
	return Pg.Executor.make({
		renderer: {
			...renderer,
			render(plan) {
				const rendered = renderer.render(plan);
				if (!/ for (share|update)$/i.test(rendered.sql)) {
					throw new Error("Lock targets require a terminal FOR SHARE or FOR UPDATE clause");
				}
				return {
					...rendered,
					sql: `${rendered.sql} OF ${targets.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ")}`,
				};
			},
		},
	});
};

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

export class ActorDatabaseError extends Data.TaggedError("ActorDatabaseError")<{
	readonly cause: unknown;
}> {
	constructor(cause: unknown) {
		super({ cause });
	}

	override get message() {
		return "Actor authority is unavailable";
	}
}

export class ActorNotCurrent extends Data.TaggedError("ActorNotCurrent")<{
	readonly actorId: string;
}> {
	constructor(actorId: string) {
		super({ actorId });
	}

	override get message() {
		return `Actor ${this.actorId} is not current`;
	}
}

export class ActorDenied extends Data.TaggedError("ActorDenied")<{ readonly reason: string }> {
	constructor(reason: string) {
		super({ reason });
	}

	override get message() {
		return this.reason;
	}
}

export class HomeOwnerUnbound extends Data.TaggedError("HomeOwnerUnbound")<{
	readonly configuredIdentity: ExternalIdentity;
}> {
	constructor(configuredIdentity: ExternalIdentity) {
		super({ configuredIdentity });
	}

	override get message() {
		return "The configured Home Host owner has not completed a verified browser login";
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

export class CapabilityContainmentConflict extends Data.TaggedError(
	"CapabilityContainmentConflict",
)<{
	readonly conflicts: readonly ContainmentConflict[];
	readonly fixes: readonly ContainmentFix[];
}> {
	constructor(conflicts: readonly ContainmentConflict[], fixes: readonly ContainmentFix[]) {
		super({ conflicts, fixes });
	}

	override get message() {
		return "Agent capability containment would be violated";
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
	missingCapabilities: readonly string[],
	isOwner: boolean,
) =>
	new CapabilityContainmentConflict(
		[
			{
				agentId: agentIdValue,
				personId: personIdValue,
				missingCapabilities,
			},
		],
		missingCapabilities.flatMap((capability): readonly ContainmentFix[] => [
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
			const executor = Pg.Executor.make();
			const execute = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
				effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
			const withTransaction = <A, E>(effect: Effect.Effect<A, E>) =>
				execute(Pg.Executor.withTransaction(effect));
			const lockContainment = () =>
				execute(
					executor.execute(
						Q.select({
							lock: advisoryLockExpression`pg_advisory_xact_lock(hashtext('grove-capability-containment'))`,
						}),
					),
				).pipe(Effect.asVoid);
			const insertCapability = (actorIdValue: string, capability: string) =>
				execute(
					executor.execute(
						Q.insert(capabilities, { actor_id: actorIdValue, capability }).pipe(
							Query.onConflict(["actor_id", "capability"], {}),
						),
					),
				);
			const deleteCapability = (actorIdValue: string, capability: string) =>
				execute(
					executor.execute(
						Q.delete(capabilities).pipe(
							Q.where(
								Q.and(
									Q.eq(capabilities.actor_id, actorIdValue),
									Q.eq(capabilities.capability, capability),
								),
							),
						),
					),
				);
			const agentCurrentQuery = Q.select({
				agent_lifecycle: agentActor.lifecycle,
				owner_lifecycle: ownerActor.lifecycle,
				owner_person_id: agents.owner_person_id,
				host_owner_id: hosts.owner_person_id,
			}).pipe(
				Q.from(agents),
				Q.innerJoin(agentActor, Q.eq(agentActor.id, agents.actor_id)),
				Q.innerJoin(ownerActor, Q.eq(ownerActor.id, agents.owner_person_id)),
				Q.innerJoin(hosts, Q.eq(hosts.id, agents.home_host_id)),
			);
			const actorForIdentity = (identity: ExternalIdentity) =>
				execute(
					executor.execute(
						Q.select({
							actor_id: actors.id,
							kind: actors.kind,
							name: actors.name,
							lifecycle: actors.lifecycle,
							auth_user_id: persons.better_auth_user_id,
							identity_use: identities.use,
							home_host_id: agents.home_host_id,
							owner_person_id: agents.owner_person_id,
						}).pipe(
							Q.from(identities),
							Q.innerJoin(actors, Q.eq(actors.id, identities.actor_id)),
							Q.leftJoin(persons, Q.eq(persons.actor_id, actors.id)),
							Q.leftJoin(agents, Q.eq(agents.actor_id, actors.id)),
							Q.where(
								Q.and(
									Q.eq(identities.issuer, identity.issuer),
									Q.eq(identities.subject, identity.subject),
								),
							),
						),
					),
				);
			const lockExternalIdentity = (identity: ExternalIdentity) =>
				execute(
					executor.execute(
						Q.select({
							lock: advisoryLockExpression`pg_advisory_xact_lock(hashtext(${Q.literal(identity.issuer)}), hashtext(${Q.literal(identity.subject)}))`,
						}),
					),
				).pipe(Effect.asVoid);
			const capabilitiesFor = (actorIdValue: string) =>
				execute(
					executor.execute(
						Q.select({ capability: capabilities.capability }).pipe(
							Q.from(capabilities),
							Q.where(Q.eq(capabilities.actor_id, actorIdValue)),
							Q.orderBy(capabilities.capability),
						),
					),
				);
			const insertDefaultCapabilities = (actorIdValue: string) =>
				Effect.forEach(SPROUT_CAPABILITIES, (capability) =>
					insertCapability(actorIdValue, capability),
				).pipe(Effect.asVoid);
			const serializeContainment = <A, E>(effect: Effect.Effect<A, E>) =>
				asDatabaseError(withTransaction(lockContainment().pipe(Effect.andThen(effect))));
			const homeReadiness = asDatabaseError(
				execute(
					executor.execute(
						Q.select({
							owner_person_id: hosts.owner_person_id,
							owner_lifecycle: actors.lifecycle,
							configured_owner: Q.exists(
								Q.select({ one: Q.literal(1) }).pipe(
									Q.from(identities),
									Q.where(
										Q.and(
											Q.eq(identities.actor_id, hosts.owner_person_id),
											Q.eq(identities.issuer, config.homeOwner.issuer),
											Q.eq(identities.subject, config.homeOwner.subject),
											Q.eq(identities.use, "browser"),
										),
									),
								),
							),
						}).pipe(
							Q.from(hosts),
							Q.leftJoin(actors, Q.eq(actors.id, hosts.owner_person_id)),
							Q.where(Q.eq(hosts.id, "host-local")),
						),
					),
				).pipe(
					Effect.map((rows): HomeReadiness => {
						const row = rows.at(0);
						if (!row?.owner_person_id) {
							return { status: "owner-unbound", configuredIdentity: config.homeOwner };
						}
						if (!row.configured_owner) {
							return {
								status: "owner-config-mismatch",
								configuredIdentity: config.homeOwner,
								ownerPersonId: row.owner_person_id,
							};
						}
						if (row.owner_lifecycle !== "active") {
							return {
								status: "owner-not-current",
								ownerPersonId: row.owner_person_id,
								lifecycle: row.owner_lifecycle ?? "retired",
							};
						}
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
							) {
								return null;
							}
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
				if (!input.emailVerified) {
					return Effect.fail(new ActorDenied("A verified browser email is required"));
				}
				const name = normalizedName(input.name);
				if (!name) {
					return Effect.fail(new ActorDenied("Person name must be between 1 and 80 characters"));
				}
				return asDatabaseError(
					withTransaction(
						Effect.gen(function* () {
							yield* lockExternalIdentity(input);
							const existing = (yield* actorForIdentity(input)).at(0);
							let actorIdValue: string;
							if (existing) {
								if (
									existing.kind !== "person" ||
									existing.identity_use !== "browser" ||
									existing.auth_user_id !== input.authUserId
								) {
									return yield* new ActorDenied(
										"The browser identity is already bound to another actor",
									);
								}
								actorIdValue = existing.actor_id;
								yield* execute(
									executor.execute(
										Q.update(actorWrites, { name, updated_at: Pg.Function.now() }).pipe(
											Q.where(Q.eq(actors.id, actorIdValue)),
										),
									),
								);
							} else {
								const byAuthUser = yield* execute(
									executor.execute(
										Q.select({ actor_id: persons.actor_id }).pipe(
											Q.from(persons),
											Q.where(Q.eq(persons.better_auth_user_id, input.authUserId)),
										),
									),
								);
								if (byAuthUser.length > 0) {
									return yield* new ActorDenied(
										"The browser account is already bound to another identity",
									);
								}
								actorIdValue = personId();
								yield* execute(
									executor.execute(
										Q.insert(actors, { id: actorIdValue, kind: "person" as const, name }),
									),
								);
								yield* execute(
									executor.execute(
										Q.insert(persons, {
											actor_id: actorIdValue,
											better_auth_user_id: input.authUserId,
										}),
									),
								);
								yield* execute(
									executor.execute(
										Q.insert(identities, {
											actor_id: actorIdValue,
											issuer: input.issuer,
											subject: input.subject,
											use: "browser" as const,
										}),
									),
								);
								yield* insertDefaultCapabilities(actorIdValue);
							}

							if (isOwnerIdentity(config.homeOwner, input)) {
								yield* execute(
									executor.execute(
										Q.update(hosts, { owner_person_id: actorIdValue }).pipe(
											Q.where(Q.and(Q.eq(hosts.id, "host-local"), Q.isNull(hosts.owner_person_id))),
										),
									),
								);
								const host = yield* execute(
									executor.execute(
										Q.select({ owner_person_id: hosts.owner_person_id }).pipe(
											Q.from(hosts),
											Q.where(Q.eq(hosts.id, "host-local")),
										),
									),
								);
								if (host.at(0)?.owner_person_id !== actorIdValue) {
									return yield* new ActorDenied(
										"The local Home Host is already owned by another Person",
									);
								}
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
							if (!actor) {
								return Effect.succeed(
									identity.scopes.has("grove:agent:enroll")
										? { ...identity, kind: "bootstrap" }
										: { ...identity, kind: "unbound" },
								);
							}
							if (
								actor.kind !== "agent" ||
								actor.identity_use !== "machine" ||
								!actor.home_host_id ||
								!actor.owner_person_id
							) {
								return Effect.fail(
									new ActorDenied("The machine identity is bound to a non-Agent actor"),
								);
							}
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
				if (!identity.scopes.has("grove:agent:enroll")) {
					return Effect.fail(new ActorDenied("Agent enrollment scope is required"));
				}
				const name = normalizedName(input.name);
				if (!name) {
					return Effect.fail(new ActorDenied("Agent name must be between 1 and 80 characters"));
				}
				return asDatabaseError(
					withTransaction(
						Effect.gen(function* () {
							yield* lockExternalIdentity(identity);
							yield* lockContainment();
							const existing = (yield* actorForIdentity(identity)).at(0);
							if (existing) {
								if (
									existing.kind !== "agent" ||
									existing.identity_use !== "machine" ||
									!existing.home_host_id ||
									!existing.owner_person_id
								) {
									return yield* new ActorDenied(
										"The external identity is already bound to another actor",
									);
								}
								const principal = {
									...identity,
									kind: "agent" as const,
									actorId: existing.actor_id,
									name: existing.name,
									homeHostId: existing.home_host_id,
									ownerPersonId: existing.owner_person_id,
								};
								const current = yield* execute(
									executor.execute(
										agentCurrentQuery.pipe(Q.where(Q.eq(agents.actor_id, existing.actor_id))),
									),
								);
								const row = current.at(0);
								if (
									row?.agent_lifecycle !== "active" ||
									row.owner_lifecycle !== "active" ||
									row.host_owner_id !== existing.owner_person_id
								) {
									return yield* new ActorNotCurrent(existing.actor_id);
								}
								return principal;
							}
							const host = yield* execute(
								executorWithLockTargets("grove_hosts").execute(
									Q.select({
										owner_person_id: hosts.owner_person_id,
										owner_lifecycle: actors.lifecycle,
									}).pipe(
										Q.from(hosts),
										Q.leftJoin(actors, Q.eq(actors.id, hosts.owner_person_id)),
										Q.where(Q.eq(hosts.id, "host-local")),
										Q.lock("update"),
									),
								),
							);
							const owner = host.at(0);
							if (!owner?.owner_person_id) {
								return yield* new HomeOwnerUnbound(config.homeOwner);
							}
							if (owner.owner_lifecycle !== "active") {
								return yield* new ActorDenied("The Home Host owner is not active");
							}

							const actorIdValue = agentId();
							yield* execute(
								executor.execute(
									Q.insert(actors, { id: actorIdValue, kind: "agent" as const, name }),
								),
							);
							yield* execute(
								executor.execute(
									Q.insert(agents, {
										actor_id: actorIdValue,
										home_host_id: "host-local",
										owner_person_id: owner.owner_person_id,
									}),
								),
							);
							yield* execute(
								executor.execute(
									Q.insert(identities, {
										actor_id: actorIdValue,
										issuer: identity.issuer,
										subject: identity.subject,
										use: "machine" as const,
									}),
								),
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
							const rows = yield* execute(
								executorWithLockTargets("grove_actors").execute(
									Q.select({ lifecycle: actors.lifecycle }).pipe(
										Q.from(actors),
										Q.innerJoin(persons, Q.eq(persons.actor_id, actors.id)),
										Q.where(
											Q.and(
												Q.eq(actors.id, principal.actorId),
												Q.eq(persons.better_auth_user_id, principal.authUserId),
											),
										),
										Q.lock("share"),
									),
								),
							);
							const row = rows.at(0);
							if (row?.lifecycle !== "active") {
								return yield* new ActorNotCurrent(principal.actorId);
							}
							const granted = yield* execute(
								executor.execute(
									Q.select({ capability: capabilities.capability }).pipe(
										Q.from(capabilities),
										Q.where(
											Q.and(
												Q.eq(capabilities.actor_id, principal.actorId),
												Q.eq(capabilities.capability, operation),
											),
										),
										Q.lock("share"),
									),
								),
							);
							if (granted.length === 0) {
								return yield* new ActorDenied(`Actor lacks ${operation}`);
							}
							return;
						}

						const rows = yield* execute(
							executorWithLockTargets("agent_actor", "owner_actor", "grove_hosts").execute(
								agentCurrentQuery.pipe(
									Q.innerJoin(identities, Q.eq(agents.actor_id, identities.actor_id)),
									Q.where(
										Q.and(
											Q.eq(identities.actor_id, principal.actorId),
											Q.eq(identities.issuer, principal.issuer),
											Q.eq(identities.subject, principal.subject),
											Q.eq(identities.use, "machine"),
										),
									),
									Q.lock("share"),
								),
							),
						);
						const row = rows.at(0);
						if (
							row?.agent_lifecycle !== "active" ||
							row.owner_lifecycle !== "active" ||
							row.host_owner_id !== principal.ownerPersonId
						) {
							return yield* new ActorNotCurrent(principal.actorId);
						}
						const granted = yield* execute(
							executor.execute(
								Q.select({ capability: capabilities.capability }).pipe(
									Q.from(capabilities),
									Q.where(
										Q.and(
											Q.eq(capabilities.actor_id, principal.actorId),
											Q.eq(capabilities.capability, operation),
										),
									),
									Q.lock("share"),
								),
							),
						);
						if (granted.length === 0) {
							return yield* new ActorDenied(`Actor lacks ${operation}`);
						}
					}),
				);
			const authorizedOperations = (principal: MachinePrincipal) => {
				if (principal.kind === "bootstrap") {
					return Effect.succeed(["agents.enrollSelf"]);
				}
				if (principal.kind === "unbound") {
					return Effect.succeed([]);
				}
				return asDatabaseError(
					withTransaction(
						authorizeActor(principal, "sprouts.list").pipe(
							Effect.andThen(capabilitiesFor(principal.actorId)),
							Effect.map((rows) => rows.map((row) => row.capability)),
						),
					),
				).pipe(Effect.catchTag(["ActorNotCurrent", "ActorDenied"], () => Effect.succeed([])));
			};
			const allowedPersons = (agentIdValue: string) =>
				execute(
					executor.execute(
						Q.unionAll(
							Q.select({
								person_id: agents.owner_person_id,
								capability: nullableCapabilityExpression`${capabilities.capability}`,
								is_owner: ownerFlag,
							}).pipe(
								Q.from(agents),
								Q.innerJoin(
									agentActor,
									Q.and(Q.eq(agentActor.id, agents.actor_id), Q.eq(agentActor.lifecycle, "active")),
								),
								Q.innerJoin(
									ownerActor,
									Q.and(
										Q.eq(ownerActor.id, agents.owner_person_id),
										Q.eq(ownerActor.lifecycle, "active"),
									),
								),
								Q.innerJoin(
									hosts,
									Q.and(
										Q.eq(hosts.id, agents.home_host_id),
										Q.eq(hosts.owner_person_id, agents.owner_person_id),
									),
								),
								Q.leftJoin(capabilities, Q.eq(capabilities.actor_id, agents.owner_person_id)),
								Q.where(Q.eq(agents.actor_id, agentIdValue)),
								(plan) => Q.as(plan, "allowed_person"),
								(source) => Q.select(source.columns).pipe(Q.from(source)),
							),
							Q.select({
								person_id: access.person_id,
								capability: nullableCapabilityExpression`${capabilities.capability}`,
								is_owner: guestFlag,
							}).pipe(
								Q.from(access),
								Q.innerJoin(
									agentActor,
									Q.and(Q.eq(agentActor.id, access.agent_id), Q.eq(agentActor.lifecycle, "active")),
								),
								Q.innerJoin(
									personActor,
									Q.and(
										Q.eq(personActor.id, access.person_id),
										Q.eq(personActor.lifecycle, "active"),
									),
								),
								Q.leftJoin(capabilities, Q.eq(capabilities.actor_id, access.person_id)),
								Q.where(Q.and(Q.eq(access.agent_id, agentIdValue), access.valid)),
								(plan) => Q.as(plan, "allowed_person"),
								(source) => Q.select(source.columns).pipe(Q.from(source)),
							),
						),
					),
				);
			const grantAgentAccess = (agentIdValue: string, personIdValue: string) =>
				Effect.gen(function* () {
					const agent = yield* execute(
						executor.execute(agentCurrentQuery.pipe(Q.where(Q.eq(agents.actor_id, agentIdValue)))),
					);
					const currentAgent = agent.at(0);
					if (
						currentAgent?.agent_lifecycle !== "active" ||
						currentAgent.owner_lifecycle !== "active" ||
						currentAgent.owner_person_id !== currentAgent.host_owner_id
					) {
						return yield* new ActorNotCurrent(agentIdValue);
					}
					const person = yield* execute(
						executor.execute(
							Q.select({ lifecycle: actors.lifecycle }).pipe(
								Q.from(actors),
								Q.innerJoin(persons, Q.eq(persons.actor_id, actors.id)),
								Q.where(Q.eq(actors.id, personIdValue)),
							),
						),
					);
					if (person.at(0)?.lifecycle !== "active") {
						return yield* new ActorNotCurrent(personIdValue);
					}
					const agentCapabilities = (yield* capabilitiesFor(agentIdValue)).map(
						(row) => row.capability,
					);
					const personCapabilities = new Set(
						(yield* execute(
							executor.execute(
								Q.select({ capability: capabilities.capability }).pipe(
									Q.from(capabilities),
									Q.innerJoin(
										actors,
										Q.and(Q.eq(actors.id, capabilities.actor_id), Q.eq(actors.lifecycle, "active")),
									),
									Q.innerJoin(persons, Q.eq(persons.actor_id, actors.id)),
									Q.where(Q.eq(capabilities.actor_id, personIdValue)),
								),
							),
						)).map((row) => row.capability),
					);
					const missing = agentCapabilities.filter(
						(capability) => !personCapabilities.has(capability),
					);
					if (missing.length > 0) {
						return yield* conflictFor(agentIdValue, personIdValue, missing, false);
					}
					yield* execute(
						executor.execute(
							Q.insert(accessWrites, { agent_id: agentIdValue, person_id: personIdValue }).pipe(
								Q.onConflict(["agent_id", "person_id"], {
									update: { valid: true, invalid_reason: null, updated_at: Pg.Function.now() },
								}),
							),
						),
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
						if (row.capability) {
							person.capabilities.add(row.capability);
						}
						grouped.set(row.person_id, person);
					}
					if (grouped.size === 0) {
						return yield* new ActorNotCurrent(agentIdValue);
					}
					const conflicts = [...grouped].filter(
						([, person]) => !person.capabilities.has(capability),
					);
					if (conflicts.length > 0) {
						const errors = conflicts.map(([personIdValue, person]) =>
							conflictFor(agentIdValue, personIdValue, [capability], person.isOwner),
						);
						return yield* new CapabilityContainmentConflict(
							errors.flatMap((error) => error.conflicts),
							errors.flatMap((error) => error.fixes),
						);
					}
					yield* insertCapability(agentIdValue, capability);
				});
			const removePersonCapability = (personIdValue: string, capability: string) => {
				if (isSproutCapability(capability)) {
					return Effect.fail(
						new ActorDenied("Sprout compatibility capabilities apply to every active actor"),
					);
				}
				return serializeContainment(
					Effect.gen(function* () {
						const rows = yield* execute(
							executor.execute(
								Q.unionAll(
									Q.select({ agent_id: agents.actor_id, is_owner: ownerFlag }).pipe(
										Q.from(agents),
										Q.innerJoin(
											actors,
											Q.and(Q.eq(actors.id, agents.actor_id), Q.eq(actors.lifecycle, "active")),
										),
										Q.innerJoin(
											capabilities,
											Q.and(
												Q.eq(capabilities.actor_id, agents.actor_id),
												Q.eq(capabilities.capability, capability),
											),
										),
										Q.where(Q.eq(agents.owner_person_id, personIdValue)),
										(plan) => Q.as(plan, "dependent_agent"),
										(source) => Q.select(source.columns).pipe(Q.from(source)),
									),
									Q.select({ agent_id: access.agent_id, is_owner: guestFlag }).pipe(
										Q.from(access),
										Q.innerJoin(
											actors,
											Q.and(Q.eq(actors.id, access.agent_id), Q.eq(actors.lifecycle, "active")),
										),
										Q.innerJoin(
											capabilities,
											Q.and(
												Q.eq(capabilities.actor_id, access.agent_id),
												Q.eq(capabilities.capability, capability),
											),
										),
										Q.where(Q.and(Q.eq(access.person_id, personIdValue), access.valid)),
										(plan) => Q.as(plan, "dependent_agent"),
										(source) => Q.select(source.columns).pipe(Q.from(source)),
									),
								),
							),
						);
						if (rows.length > 0) {
							const errors = rows.map((row) =>
								conflictFor(row.agent_id, personIdValue, [capability], row.is_owner),
							);
							return yield* new CapabilityContainmentConflict(
								errors.flatMap((error) => error.conflicts),
								errors.flatMap((error) => error.fixes),
							);
						}
						yield* deleteCapability(personIdValue, capability);
					}),
				);
			};
			const applyContainmentFix = (fix: Omit<ContainmentFix, "available" | "reason">) => {
				switch (fix.action) {
					case "grant-person-capability":
						return Effect.gen(function* () {
							const relationship = yield* execute(
								executor.execute(
									Q.unionAll(
										Q.select({ allowed: Q.literal(true) }).pipe(
											Q.from(agents),
											Q.where(
												Q.and(
													Q.eq(agents.actor_id, fix.agentId),
													Q.eq(agents.owner_person_id, fix.personId),
												),
											),
										),
										Q.select({ allowed: Q.literal(true) }).pipe(
											Q.from(access),
											Q.where(
												Q.and(
													Q.eq(access.agent_id, fix.agentId),
													Q.eq(access.person_id, fix.personId),
													access.valid,
												),
											),
										),
									),
								),
							);
							if (relationship.length === 0) {
								return yield* new ActorDenied("The Person does not have access to this Agent");
							}
							yield* insertCapability(fix.personId, fix.capability);
						});
					case "remove-agent-access":
						return Effect.gen(function* () {
							const owner = yield* execute(
								executor.execute(
									Q.select({ owner_person_id: agents.owner_person_id }).pipe(
										Q.from(agents),
										Q.where(Q.eq(agents.actor_id, fix.agentId)),
									),
								),
							);
							if (owner.at(0)?.owner_person_id === fix.personId) {
								return yield* new ActorDenied(
									"A Home Host owner cannot lose access to a hosted Agent",
								);
							}
							yield* execute(
								executor.execute(
									Q.update(accessWrites, {
										valid: false,
										invalid_reason: "removed-by-explicit-fix",
										updated_at: Pg.Function.now(),
									}).pipe(
										Q.where(
											Q.and(
												Q.eq(access.agent_id, fix.agentId),
												Q.eq(access.person_id, fix.personId),
											),
										),
									),
								),
							);
						});
					case "remove-agent-capability":
						if (isSproutCapability(fix.capability)) {
							return Effect.fail(
								new ActorDenied("Sprout compatibility capabilities apply to every active actor"),
							);
						}
						return deleteCapability(fix.agentId, fix.capability).pipe(Effect.asVoid);
				}
			};
			const requireAgentManager = (
				principal: PersonPrincipal,
				agentIdValue: string,
				requireCurrentAgent: boolean,
			) =>
				execute(
					executorWithLockTargets(
						"grove_agents",
						"grove_hosts",
						"manager_actor",
						"agent_actor",
					).execute(
						Q.select({ owner_person_id: agents.owner_person_id }).pipe(
							Q.from(agents),
							Q.innerJoin(
								hosts,
								Q.and(
									Q.eq(hosts.id, agents.home_host_id),
									Q.eq(hosts.owner_person_id, agents.owner_person_id),
								),
							),
							Q.innerJoin(persons, Q.eq(persons.actor_id, agents.owner_person_id)),
							Q.innerJoin(
								managerActor,
								Q.and(
									Q.eq(managerActor.id, persons.actor_id),
									Q.eq(managerActor.lifecycle, "active"),
								),
							),
							Q.innerJoin(agentActor, Q.eq(agentActor.id, agents.actor_id)),
							Q.where(
								Q.and(
									Q.eq(agents.actor_id, agentIdValue),
									Q.eq(agents.owner_person_id, principal.actorId),
									Q.eq(persons.better_auth_user_id, principal.authUserId),
									Q.or(Q.not(Q.literal(requireCurrentAgent)), Q.eq(agentActor.lifecycle, "active")),
								),
							),
							Q.lock("share"),
						),
					),
				).pipe(
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
					const rows = yield* execute(
						executor.execute(
							Q.select({ lifecycle: actors.lifecycle }).pipe(
								Q.from(actors),
								Q.where(Q.eq(actors.id, actorIdValue)),
								Q.lock("update"),
							),
						),
					);
					const current = rows.at(0)?.lifecycle;
					if (!current) {
						return yield* new ActorNotCurrent(actorIdValue);
					}
					if (current === "retired" && lifecycle !== "retired") {
						return yield* new ActorDenied("A retired Actor cannot change lifecycle");
					}
					yield* execute(
						executor.execute(
							Q.update(actorWrites, { lifecycle, updated_at: Pg.Function.now() }).pipe(
								Q.where(Q.eq(actors.id, actorIdValue)),
							),
						),
					);
					yield* execute(
						executor.execute(
							Q.update(accessWrites, {
								valid: false,
								invalid_reason: `actor-${lifecycle}`,
								updated_at: Pg.Function.now(),
							}).pipe(
								Q.where(
									Q.and(
										access.valid,
										Q.or(
											Q.eq(access.agent_id, actorIdValue),
											Q.eq(access.person_id, actorIdValue),
											Q.inSubquery(
												access.agent_id,
												Q.select({ actor_id: agents.actor_id }).pipe(
													Q.from(agents),
													Q.where(Q.eq(agents.owner_person_id, actorIdValue)),
												),
											),
										),
									),
								),
							),
						),
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
