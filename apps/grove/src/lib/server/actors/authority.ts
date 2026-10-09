import * as PgClient from "@effect/sql-pg/PgClient";
import { and, eq, exists, inArray, isNull, not, or, sql } from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";
import { Cause, Context, Data, Effect, Layer, Schema } from "effect";

import { makeDatabase } from "../db/client";
import { actors, persons, agents, access, identities, hosts, capabilities } from "../db/tables";

const agentActor = alias(actors, "agent_actor");
const ownerActor = alias(actors, "owner_actor");
const personActor = alias(actors, "person_actor");
const managerActor = alias(actors, "manager_actor");
const ownerFlag = sql<boolean>`true`.as("is_owner");
const guestFlag = sql<boolean>`false`.as("is_owner");

const Lifecycle = Schema.Literals(["active", "dormant", "suspended", "retired"]);
// Drizzle's $type is static only; decode each executed SELECT's required shape.
const IdentityRow = Schema.Struct({
	actor_id: Schema.String,
	kind: Schema.Literals(["person", "agent"]),
	name: Schema.String,
	lifecycle: Lifecycle,
	auth_user_id: Schema.NullOr(Schema.String),
	identity_use: Schema.Literals(["browser", "machine"]),
	home_host_id: Schema.NullOr(Schema.String),
	owner_person_id: Schema.NullOr(Schema.String),
});
const AgentCurrentRow = Schema.Struct({
	agent_lifecycle: Lifecycle,
	owner_lifecycle: Lifecycle,
	owner_person_id: Schema.String,
	host_owner_id: Schema.NullOr(Schema.String),
});
const HostOwnerRow = Schema.Struct({ owner_person_id: Schema.NullOr(Schema.String) });
const HostCurrentRow = Schema.Struct({
	...HostOwnerRow.fields,
	owner_lifecycle: Schema.NullOr(Lifecycle),
});
const HomeReadinessRow = Schema.Struct({
	...HostCurrentRow.fields,
	configured_owner: Schema.Boolean,
});
const ActorIdRow = Schema.Struct({ actor_id: Schema.String });
const LifecycleRow = Schema.Struct({ lifecycle: Lifecycle });
const CapabilityRow = Schema.Struct({ capability: Schema.String });
const AllowedPersonRow = Schema.Struct({
	person_id: Schema.String,
	capability: Schema.NullOr(Schema.String),
	is_owner: Schema.Boolean,
});
const ContainedAgentRow = Schema.Struct({ agent_id: Schema.String, is_owner: Schema.Boolean });
const RelationshipRow = Schema.Struct({ allowed: Schema.Boolean });
const AgentOwnerRow = Schema.Struct({ owner_person_id: Schema.String });
const decodeRows = <S extends Schema.Top, A, E>(schema: S, query: Effect.Effect<A, E>) =>
	query.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(schema))));

const SPROUT_CAPABILITIES = [
	"sprouts.list",
	"sprouts.get",
	"sprouts.create",
	"sprouts.water",
	"sprouts.remove",
] as const;
const isSproutCapability = (capability: string) =>
	(SPROUT_CAPABILITIES as readonly string[]).includes(capability);

const DEFAULT_CAPABILITIES = [
	...SPROUT_CAPABILITIES,
	"project.create",
	"project.plan",
	"task.claim",
	"claim.renew",
	"claim.release",
	"attempt.publish",
	"work.ready",
	"review.submit",
	"task.complete",
	"library.search",
	"library.getVersion",
] as const;

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
	override get message() {
		return "Actor authority is unavailable";
	}
}

export class ActorNotCurrent extends Data.TaggedError("ActorNotCurrent")<{
	readonly actorId: string;
}> {
	override get message() {
		return `Actor ${this.actorId} is not current`;
	}
}

export class ActorDenied extends Data.TaggedError("ActorDenied")<{ readonly reason: string }> {
	override get message() {
		return this.reason;
	}
}

export class HomeOwnerUnbound extends Data.TaggedError("HomeOwnerUnbound")<{
	readonly configuredIdentity: ExternalIdentity;
}> {
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

			return Effect.fail(isAuthorityError(error) ? error : new ActorDatabaseError({ cause }));
		}),
	);

const conflictFor = (
	agentIdValue: string,
	personIdValue: string,
	missingCapabilities: readonly string[],
	isOwner: boolean,
) =>
	new CapabilityContainmentConflict({
		conflicts: [
			{
				agentId: agentIdValue,
				personId: personIdValue,
				missingCapabilities,
			},
		],
		fixes: missingCapabilities.flatMap((capability): readonly ContainmentFix[] => [
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
	});

export const ActorAuthorityLayer = (config: ActorAuthorityConfig) =>
	Layer.effect(
		ActorAuthority,
		Effect.gen(function* () {
			const pg = yield* PgClient.PgClient;
			const db = yield* makeDatabase(pg);
			const withTransaction = <A, E>(effect: Effect.Effect<A, E>) => pg.withTransaction(effect);
			const lockContainment = () =>
				pg`select pg_advisory_xact_lock(hashtext('grove-capability-containment'))`.pipe(
					Effect.asVoid,
				);
			const insertCapability = (actorIdValue: string, capability: string) =>
				Effect.asVoid(
					db
						.insert(capabilities)
						.values({ actor_id: actorIdValue, capability })
						.onConflictDoNothing({ target: [capabilities.actor_id, capabilities.capability] }),
				);
			const deleteCapability = (actorIdValue: string, capability: string) =>
				Effect.asVoid(
					db
						.delete(capabilities)
						.where(
							and(eq(capabilities.actor_id, actorIdValue), eq(capabilities.capability, capability)),
						),
				);
			const agentCurrentQuery = () =>
				db
					.select({
						agent_lifecycle: agentActor.lifecycle,
						owner_lifecycle: ownerActor.lifecycle,
						owner_person_id: agents.owner_person_id,
						host_owner_id: hosts.owner_person_id,
					})
					.from(agents)
					.innerJoin(agentActor, eq(agentActor.id, agents.actor_id))
					.innerJoin(ownerActor, eq(ownerActor.id, agents.owner_person_id))
					.innerJoin(hosts, eq(hosts.id, agents.home_host_id));
			const actorForIdentity = (identity: ExternalIdentity) =>
				decodeRows(
					IdentityRow,
					db
						.select({
							actor_id: actors.id,
							kind: actors.kind,
							name: actors.name,
							lifecycle: actors.lifecycle,
							auth_user_id: persons.better_auth_user_id,
							identity_use: identities.use,
							home_host_id: agents.home_host_id,
							owner_person_id: agents.owner_person_id,
						})
						.from(identities)
						.innerJoin(actors, eq(actors.id, identities.actor_id))
						.leftJoin(persons, eq(persons.actor_id, actors.id))
						.leftJoin(agents, eq(agents.actor_id, actors.id))
						.where(
							and(eq(identities.issuer, identity.issuer), eq(identities.subject, identity.subject)),
						),
				);
			const lockExternalIdentity = (identity: ExternalIdentity) =>
				pg`select pg_advisory_xact_lock(hashtext(${identity.issuer}), hashtext(${identity.subject}))`.pipe(
					Effect.asVoid,
				);
			const capabilitiesFor = (actorIdValue: string) =>
				decodeRows(
					CapabilityRow,
					db
						.select({ capability: capabilities.capability })
						.from(capabilities)
						.where(eq(capabilities.actor_id, actorIdValue))
						.orderBy(capabilities.capability),
				);
			const insertDefaultCapabilities = (
				actorIdValue: string,
				grants: readonly string[] = DEFAULT_CAPABILITIES,
			) =>
				Effect.forEach(grants, (capability) => insertCapability(actorIdValue, capability)).pipe(
					Effect.asVoid,
				);
			const serializeContainment = <A, E>(effect: Effect.Effect<A, E>) =>
				asDatabaseError(withTransaction(lockContainment().pipe(Effect.andThen(effect))));
			const homeReadiness = asDatabaseError(
				decodeRows(
					HomeReadinessRow,
					db
						.select({
							owner_person_id: hosts.owner_person_id,
							owner_lifecycle: actors.lifecycle,
							configured_owner: exists(
								db
									.select({ one: sql`${1}` })
									.from(identities)
									.where(
										and(
											eq(identities.actor_id, hosts.owner_person_id),
											eq(identities.issuer, config.homeOwner.issuer),
											eq(identities.subject, config.homeOwner.subject),
											eq(identities.use, "browser"),
										),
									),
							),
						})
						.from(hosts)
						.leftJoin(actors, eq(actors.id, hosts.owner_person_id))
						.where(eq(hosts.id, "host-local")),
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

						const ownerLifecycle = row.owner_lifecycle;

						if (ownerLifecycle !== "active") {
							return {
								status: "owner-not-current",
								ownerPersonId: row.owner_person_id,
								lifecycle: ownerLifecycle ?? "retired",
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
					return Effect.fail(new ActorDenied({ reason: "A verified browser email is required" }));
				}

				const name = normalizedName(input.name);

				if (!name) {
					return Effect.fail(
						new ActorDenied({ reason: "Person name must be between 1 and 80 characters" }),
					);
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
									return yield* new ActorDenied({
										reason: "The browser identity is already bound to another actor",
									});
								}

								actorIdValue = existing.actor_id;

								yield* Effect.asVoid(
									db
										.update(actors)
										.set({ name, updated_at: sql`now()` })
										.where(eq(actors.id, actorIdValue)),
								);
							} else {
								const byAuthUser = yield* decodeRows(
									ActorIdRow,
									db
										.select({ actor_id: persons.actor_id })
										.from(persons)
										.where(eq(persons.better_auth_user_id, input.authUserId)),
								);

								if (byAuthUser.length > 0) {
									return yield* new ActorDenied({
										reason: "The browser account is already bound to another identity",
									});
								}

								actorIdValue = personId();

								yield* Effect.asVoid(
									db.insert(actors).values({ id: actorIdValue, kind: "person" as const, name }),
								);

								yield* Effect.asVoid(
									db.insert(persons).values({
										actor_id: actorIdValue,
										better_auth_user_id: input.authUserId,
									}),
								);

								yield* Effect.asVoid(
									db.insert(identities).values({
										actor_id: actorIdValue,
										issuer: input.issuer,
										subject: input.subject,
										use: "browser" as const,
									}),
								);

								yield* insertDefaultCapabilities(actorIdValue);
							}

							if (isOwnerIdentity(config.homeOwner, input)) {
								yield* Effect.asVoid(
									db
										.update(hosts)
										.set({ owner_person_id: actorIdValue })
										.where(and(eq(hosts.id, "host-local"), isNull(hosts.owner_person_id))),
								);

								const host = yield* decodeRows(
									HostOwnerRow,
									db
										.select({ owner_person_id: hosts.owner_person_id })
										.from(hosts)
										.where(eq(hosts.id, "host-local")),
								);

								if (host.at(0)?.owner_person_id !== actorIdValue) {
									return yield* new ActorDenied({
										reason: "The local Home Host is already owned by another Person",
									});
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
									new ActorDenied({ reason: "The machine identity is bound to a non-Agent actor" }),
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
					return Effect.fail(new ActorDenied({ reason: "Agent enrollment scope is required" }));
				}

				const name = normalizedName(input.name);

				if (!name) {
					return Effect.fail(
						new ActorDenied({ reason: "Agent name must be between 1 and 80 characters" }),
					);
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
									return yield* new ActorDenied({
										reason: "The external identity is already bound to another actor",
									});
								}

								const principal = {
									...identity,
									kind: "agent" as const,
									actorId: existing.actor_id,
									name: existing.name,
									homeHostId: existing.home_host_id,
									ownerPersonId: existing.owner_person_id,
								};
								const current = yield* decodeRows(
									AgentCurrentRow,
									agentCurrentQuery().where(eq(agents.actor_id, existing.actor_id)),
								);
								const row = current.at(0);

								if (
									row?.agent_lifecycle !== "active" ||
									row.owner_lifecycle !== "active" ||
									row.host_owner_id !== existing.owner_person_id
								) {
									return yield* new ActorNotCurrent({ actorId: existing.actor_id });
								}

								return principal;
							}

							const host = yield* decodeRows(
								HostCurrentRow,
								db
									.select({
										owner_person_id: hosts.owner_person_id,
										owner_lifecycle: actors.lifecycle,
									})
									.from(hosts)
									.leftJoin(actors, eq(actors.id, hosts.owner_person_id))
									.where(eq(hosts.id, "host-local"))
									.for("update", { of: [hosts] }),
							);
							const owner = host.at(0);

							if (!owner?.owner_person_id) {
								return yield* new HomeOwnerUnbound({ configuredIdentity: config.homeOwner });
							}

							if (owner.owner_lifecycle !== "active") {
								return yield* new ActorDenied({ reason: "The Home Host owner is not active" });
							}

							const actorIdValue = agentId();

							yield* Effect.asVoid(
								db.insert(actors).values({ id: actorIdValue, kind: "agent" as const, name }),
							);

							yield* Effect.asVoid(
								db.insert(agents).values({
									actor_id: actorIdValue,
									home_host_id: "host-local",
									owner_person_id: owner.owner_person_id,
								}),
							);

							yield* Effect.asVoid(
								db.insert(identities).values({
									actor_id: actorIdValue,
									issuer: identity.issuer,
									subject: identity.subject,
									use: "machine" as const,
								}),
							);

							const ownerCapabilities = new Set(
								(yield* capabilitiesFor(owner.owner_person_id)).map(({ capability }) => capability),
							);

							yield* insertDefaultCapabilities(
								actorIdValue,
								DEFAULT_CAPABILITIES.filter((capability) => ownerCapabilities.has(capability)),
							);

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
							const rows = yield* decodeRows(
								LifecycleRow,
								db
									.select({ lifecycle: actors.lifecycle })
									.from(actors)
									.innerJoin(persons, eq(persons.actor_id, actors.id))
									.where(
										and(
											eq(actors.id, principal.actorId),
											eq(persons.better_auth_user_id, principal.authUserId),
										),
									)
									.for("share", { of: [actors] }),
							);
							const row = rows.at(0);

							if (row?.lifecycle !== "active") {
								return yield* new ActorNotCurrent({ actorId: principal.actorId });
							}

							const granted = yield* decodeRows(
								CapabilityRow,
								db
									.select({ capability: capabilities.capability })
									.from(capabilities)
									.where(
										and(
											eq(capabilities.actor_id, principal.actorId),
											eq(capabilities.capability, operation),
										),
									)
									.for("share"),
							);

							if (granted.length === 0) {
								return yield* new ActorDenied({ reason: `Actor lacks ${operation}` });
							}

							return;
						}

						const rows = yield* decodeRows(
							AgentCurrentRow,
							agentCurrentQuery()
								.innerJoin(identities, eq(agents.actor_id, identities.actor_id))
								.where(
									and(
										eq(identities.actor_id, principal.actorId),
										eq(identities.issuer, principal.issuer),
										eq(identities.subject, principal.subject),
										eq(identities.use, "machine"),
									),
								)
								.for("share", { of: [agentActor, ownerActor, hosts] }),
						);
						const row = rows.at(0);

						if (
							row?.agent_lifecycle !== "active" ||
							row.owner_lifecycle !== "active" ||
							row.host_owner_id !== principal.ownerPersonId
						) {
							return yield* new ActorNotCurrent({ actorId: principal.actorId });
						}

						const granted = yield* decodeRows(
							CapabilityRow,
							db
								.select({ capability: capabilities.capability })
								.from(capabilities)
								.where(
									and(
										eq(capabilities.actor_id, principal.actorId),
										eq(capabilities.capability, operation),
									),
								)
								.for("share"),
						);

						if (granted.length === 0) {
							return yield* new ActorDenied({ reason: `Actor lacks ${operation}` });
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
				decodeRows(
					AllowedPersonRow,
					unionAll(
						db
							.select({
								person_id: agents.owner_person_id,
								capability: sql<string | null>`${capabilities.capability}`.as("capability"),
								is_owner: ownerFlag,
							})
							.from(agents)
							.innerJoin(
								agentActor,
								and(eq(agentActor.id, agents.actor_id), eq(agentActor.lifecycle, "active")),
							)
							.innerJoin(
								ownerActor,
								and(eq(ownerActor.id, agents.owner_person_id), eq(ownerActor.lifecycle, "active")),
							)
							.innerJoin(
								hosts,
								and(
									eq(hosts.id, agents.home_host_id),
									eq(hosts.owner_person_id, agents.owner_person_id),
								),
							)
							.leftJoin(capabilities, eq(capabilities.actor_id, agents.owner_person_id))
							.where(eq(agents.actor_id, agentIdValue)),
						db
							.select({
								person_id: access.person_id,
								capability: sql<string | null>`${capabilities.capability}`.as("capability"),
								is_owner: guestFlag,
							})
							.from(access)
							.innerJoin(
								agentActor,
								and(eq(agentActor.id, access.agent_id), eq(agentActor.lifecycle, "active")),
							)
							.innerJoin(
								personActor,
								and(eq(personActor.id, access.person_id), eq(personActor.lifecycle, "active")),
							)
							.leftJoin(capabilities, eq(capabilities.actor_id, access.person_id))
							.where(and(eq(access.agent_id, agentIdValue), access.valid)),
					),
				);
			const grantAgentAccess = (agentIdValue: string, personIdValue: string) =>
				Effect.gen(function* () {
					const agent = yield* decodeRows(
						AgentCurrentRow,
						agentCurrentQuery().where(eq(agents.actor_id, agentIdValue)),
					);
					const currentAgent = agent.at(0);

					if (
						currentAgent?.agent_lifecycle !== "active" ||
						currentAgent.owner_lifecycle !== "active" ||
						currentAgent.owner_person_id !== currentAgent.host_owner_id
					) {
						return yield* new ActorNotCurrent({ actorId: agentIdValue });
					}

					const person = yield* decodeRows(
						LifecycleRow,
						db
							.select({ lifecycle: actors.lifecycle })
							.from(actors)
							.innerJoin(persons, eq(persons.actor_id, actors.id))
							.where(eq(actors.id, personIdValue)),
					);

					if (person.at(0)?.lifecycle !== "active") {
						return yield* new ActorNotCurrent({ actorId: personIdValue });
					}

					const agentCapabilities = (yield* capabilitiesFor(agentIdValue)).map(
						(row) => row.capability,
					);
					const personCapabilities = new Set(
						(yield* decodeRows(
							CapabilityRow,
							db
								.select({ capability: capabilities.capability })
								.from(capabilities)
								.innerJoin(
									actors,
									and(eq(actors.id, capabilities.actor_id), eq(actors.lifecycle, "active")),
								)
								.innerJoin(persons, eq(persons.actor_id, actors.id))
								.where(eq(capabilities.actor_id, personIdValue)),
						)).map((row) => row.capability),
					);
					const missing = agentCapabilities.filter(
						(capability) => !personCapabilities.has(capability),
					);

					if (missing.length > 0) {
						return yield* conflictFor(agentIdValue, personIdValue, missing, false);
					}

					yield* Effect.asVoid(
						db
							.insert(access)
							.values({ agent_id: agentIdValue, person_id: personIdValue })
							.onConflictDoUpdate({
								target: [access.agent_id, access.person_id],
								set: { valid: true, invalid_reason: null, updated_at: sql`now()` },
							}),
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
						return yield* new ActorNotCurrent({ actorId: agentIdValue });
					}

					const conflicts = [...grouped].filter(
						([, person]) => !person.capabilities.has(capability),
					);

					if (conflicts.length > 0) {
						const errors = conflicts.map(([personIdValue, person]) =>
							conflictFor(agentIdValue, personIdValue, [capability], person.isOwner),
						);

						return yield* new CapabilityContainmentConflict({
							conflicts: errors.flatMap((error) => error.conflicts),
							fixes: errors.flatMap((error) => error.fixes),
						});
					}

					yield* insertCapability(agentIdValue, capability);
				});
			const removePersonCapability = (personIdValue: string, capability: string) => {
				if (isSproutCapability(capability)) {
					return Effect.fail(
						new ActorDenied({
							reason: "Sprout compatibility capabilities apply to every active actor",
						}),
					);
				}

				return serializeContainment(
					Effect.gen(function* () {
						const rows = yield* decodeRows(
							ContainedAgentRow,
							unionAll(
								db
									.select({ agent_id: agents.actor_id, is_owner: ownerFlag })
									.from(agents)
									.innerJoin(
										actors,
										and(eq(actors.id, agents.actor_id), eq(actors.lifecycle, "active")),
									)
									.innerJoin(
										capabilities,
										and(
											eq(capabilities.actor_id, agents.actor_id),
											eq(capabilities.capability, capability),
										),
									)
									.where(eq(agents.owner_person_id, personIdValue)),
								db
									.select({ agent_id: access.agent_id, is_owner: guestFlag })
									.from(access)
									.innerJoin(
										actors,
										and(eq(actors.id, access.agent_id), eq(actors.lifecycle, "active")),
									)
									.innerJoin(
										capabilities,
										and(
											eq(capabilities.actor_id, access.agent_id),
											eq(capabilities.capability, capability),
										),
									)
									.where(and(eq(access.person_id, personIdValue), access.valid)),
							),
						);

						if (rows.length > 0) {
							const errors = rows.map((row) =>
								conflictFor(row.agent_id, personIdValue, [capability], row.is_owner),
							);

							return yield* new CapabilityContainmentConflict({
								conflicts: errors.flatMap((error) => error.conflicts),
								fixes: errors.flatMap((error) => error.fixes),
							});
						}

						yield* deleteCapability(personIdValue, capability);
					}),
				);
			};

			const applyContainmentFix = (fix: Omit<ContainmentFix, "available" | "reason">) => {
				switch (fix.action) {
					case "grant-person-capability":
						return Effect.gen(function* () {
							const relationship = yield* decodeRows(
								RelationshipRow,
								unionAll(
									db
										.select({ allowed: sql<boolean>`true`.as("allowed") })
										.from(agents)
										.where(
											and(
												eq(agents.actor_id, fix.agentId),
												eq(agents.owner_person_id, fix.personId),
											),
										),
									db
										.select({ allowed: sql<boolean>`true`.as("allowed") })
										.from(access)
										.where(
											and(
												eq(access.agent_id, fix.agentId),
												eq(access.person_id, fix.personId),
												access.valid,
											),
										),
								),
							);

							if (relationship.length === 0) {
								return yield* new ActorDenied({
									reason: "The Person does not have access to this Agent",
								});
							}

							yield* insertCapability(fix.personId, fix.capability);
						});
					case "remove-agent-access":
						return Effect.gen(function* () {
							const owner = yield* decodeRows(
								AgentOwnerRow,
								db
									.select({ owner_person_id: agents.owner_person_id })
									.from(agents)
									.where(eq(agents.actor_id, fix.agentId)),
							);

							if (owner.at(0)?.owner_person_id === fix.personId) {
								return yield* new ActorDenied({
									reason: "A Home Host owner cannot lose access to a hosted Agent",
								});
							}

							yield* Effect.asVoid(
								db
									.update(access)
									.set({
										valid: false,
										invalid_reason: "removed-by-explicit-fix",
										updated_at: sql`now()`,
									})
									.where(and(eq(access.agent_id, fix.agentId), eq(access.person_id, fix.personId))),
							);
						});
					case "remove-agent-capability":
						if (isSproutCapability(fix.capability)) {
							return Effect.fail(
								new ActorDenied({
									reason: "Sprout compatibility capabilities apply to every active actor",
								}),
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
				decodeRows(
					AgentOwnerRow,
					db
						.select({ owner_person_id: agents.owner_person_id })
						.from(agents)
						.innerJoin(
							hosts,
							and(
								eq(hosts.id, agents.home_host_id),
								eq(hosts.owner_person_id, agents.owner_person_id),
							),
						)
						.innerJoin(persons, eq(persons.actor_id, agents.owner_person_id))
						.innerJoin(
							managerActor,
							and(eq(managerActor.id, persons.actor_id), eq(managerActor.lifecycle, "active")),
						)
						.innerJoin(agentActor, eq(agentActor.id, agents.actor_id))
						.where(
							and(
								eq(agents.actor_id, agentIdValue),
								eq(agents.owner_person_id, principal.actorId),
								eq(persons.better_auth_user_id, principal.authUserId),
								or(not(sql`${requireCurrentAgent}`), eq(agentActor.lifecycle, "active")),
							),
						)
						.for("share", { of: [agents, hosts, managerActor, agentActor] }),
				).pipe(
					Effect.flatMap((rows) =>
						rows.length === 1
							? Effect.void
							: Effect.fail(
									new ActorDenied({ reason: "Only the Home Host owner may manage this Agent" }),
								),
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
					const rows = yield* decodeRows(
						LifecycleRow,
						db
							.select({ lifecycle: actors.lifecycle })
							.from(actors)
							.where(eq(actors.id, actorIdValue))
							.for("update"),
					);
					const current = rows.at(0)?.lifecycle;

					if (!current) {
						return yield* new ActorNotCurrent({ actorId: actorIdValue });
					}

					if (current === "retired" && lifecycle !== "retired") {
						return yield* new ActorDenied({ reason: "A retired Actor cannot change lifecycle" });
					}

					yield* Effect.asVoid(
						db
							.update(actors)
							.set({ lifecycle, updated_at: sql`now()` })
							.where(eq(actors.id, actorIdValue)),
					);

					yield* Effect.asVoid(
						db
							.update(access)
							.set({
								valid: false,
								invalid_reason: `actor-${lifecycle}`,
								updated_at: sql`now()`,
							})
							.where(
								and(
									access.valid,
									or(
										eq(access.agent_id, actorIdValue),
										eq(access.person_id, actorIdValue),
										inArray(
											access.agent_id,
											db
												.select({ actor_id: agents.actor_id })
												.from(agents)
												.where(eq(agents.owner_person_id, actorIdValue)),
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
						: Effect.fail(
								new ActorDenied({ reason: "A Person may reduce only their own capabilities" }),
							),
				applyContainmentFixAs: (principal, fix) =>
					authorizedAgentMutation(principal, fix.agentId, applyContainmentFix(fix)),
				suspendAgentAs: (principal, agentIdValue) =>
					setAgentLifecycleAs(principal, agentIdValue, "suspended"),
				retireAgentAs: (principal, agentIdValue) =>
					setAgentLifecycleAs(principal, agentIdValue, "retired"),
			} satisfies ActorAuthorityShape;
		}),
	);
