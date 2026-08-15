import { Schema } from "effect";

export const EnrollAgentSelf = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
});

export const EnrolledAgent = Schema.Struct({
	kind: Schema.Literal("agent"),
	actorId: Schema.String,
	name: Schema.String,
	homeHostId: Schema.String,
	ownerPersonId: Schema.String,
});

export type EnrollAgentSelf = typeof EnrollAgentSelf.Type;

const AuthorityIdentifier = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120));
const AgentCapability = Schema.Struct({
	agentId: AuthorityIdentifier,
	capability: AuthorityIdentifier,
});
const ContainmentFixInput = Schema.Struct({
	action: Schema.Literals([
		"grant-person-capability",
		"remove-agent-access",
		"remove-agent-capability",
	]),
	agentId: AuthorityIdentifier,
	personId: AuthorityIdentifier,
	capability: AuthorityIdentifier,
});
export const AgentCapabilityValidator = Schema.toStandardSchemaV1(AgentCapability);
export const ContainmentFixValidator = Schema.toStandardSchemaV1(ContainmentFixInput);
