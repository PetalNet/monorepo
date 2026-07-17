import { createHash } from "node:crypto";

import type { Sql } from "postgres";

import { uuidv5 } from "../bridge/uuid5.ts";

export class CapabilityContributionError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export interface CapabilityProposalInput {
	capability: string;
	title: string;
	version: string;
	scope: string;
	reason: string;
	artifactBase64: string;
}

const CAPABILITY = /^(?:skill|tool)\.[a-z0-9][a-z0-9._-]{0,126}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;

export async function proposeCapability(
	writer: Sql,
	principal: { id: string; kind: string; scopes: readonly string[] },
	input: CapabilityProposalInput,
): Promise<Record<string, unknown>> {
	if (principal.kind !== "agent")
		throw new CapabilityContributionError("agent_required", "only agents may propose capabilities");
	if (!principal.scopes.includes(input.scope))
		throw new CapabilityContributionError(
			"scope_denied",
			"proposal scope is not visible to the agent",
		);
	if (!CAPABILITY.test(input.capability) || !VERSION.test(input.version))
		throw new CapabilityContributionError(
			"bad_proposal",
			"capability or semantic version is invalid",
		);
	const artifact = Buffer.from(input.artifactBase64, "base64");
	if (
		artifact.length < 1 ||
		artifact.length > 1_048_576 ||
		artifact.toString("base64") !== input.artifactBase64
	)
		throw new CapabilityContributionError(
			"bad_proposal",
			"artifact must be canonical base64 and at most 1 MiB",
		);
	const digest = createHash("sha256").update(artifact).digest("hex");
	const proposalId = `cap_${uuidv5(`${principal.id}:${input.capability}:${input.version}:${digest}`)}`;
	const itemId = `proposed_${uuidv5(proposalId)}`;
	const blobId = `blob_${uuidv5(`${proposalId}:artifact`)}`;
	return writer.begin(async (tx) => {
		// Serialize the logical capability-version key so different artifact bytes cannot race the
		// duplicate check and create two live review candidates.
		await tx`select pg_advisory_xact_lock(hashtextextended(${`${input.capability}:${input.version}`}, 0))`;
		const duplicate = await tx<{ id: string }[]>`select id from library_curation
			where capability = ${input.capability} and version = ${input.version}
			and state in ('proposed','under-review','promoted') limit 1`;
		if (duplicate.at(0))
			throw new CapabilityContributionError(
				"proposal_exists",
				"this capability version is already proposed",
			);
		await tx`insert into blobs (id, scope, bytes) values (${blobId}, ${input.scope}, ${artifact})`;
		await tx`insert into library_items
			(id, entity_id, kind, title, scope, project, status, body_ref, properties, created_by, protection)
			values (${itemId}, ${itemId}, 'artifact', ${input.title}, ${input.scope}, 'registry', 'draft',
			${blobId}, ${tx.json({ artifact_type: "capability", capability: input.capability, capability_kind: input.capability.startsWith("skill.") ? "skill" : "tool", version: input.version, sha256: digest })}, ${principal.id}, 'full')`;
		await tx`insert into library_curation
			(id, item_id, proposal_type, reason, scope, state, capability, version, sha256, proposed_by)
			values (${proposalId}, ${itemId}, 'capability', ${input.reason}, ${input.scope}, 'proposed',
			${input.capability}, ${input.version}, ${digest}, ${principal.id})`;
		return {
			schema_version: 1,
			proposal_id: proposalId,
			item_id: itemId,
			capability: input.capability,
			version: input.version,
			state: "proposed",
			integrity: { algorithm: "sha256", digest },
		};
	});
}

export async function reviewCapability(
	writer: Sql,
	proposalId: string,
	decision: "under-review" | "promoted" | "rejected",
	reviewer: string,
	reason: string,
): Promise<Record<string, unknown>> {
	return writer.begin(async (tx) => {
		const rows = await tx<
			{
				item_id: string;
				capability: string | null;
				version: string | null;
				sha256: string | null;
				scope: string;
				state: string;
				proposed_by: string | null;
			}[]
		>`
			select item_id, capability, version, sha256, scope, state, proposed_by from library_curation where id = ${proposalId} for update`;
		const proposal = rows[0];
		if (!proposal.capability || !proposal.version || !proposal.sha256)
			throw new CapabilityContributionError(
				"proposal_not_found",
				"capability proposal was not found",
			);
		const allowed =
			decision === "under-review"
				? proposal.state === "proposed"
				: proposal.state === "proposed" || proposal.state === "under-review";
		if (!allowed)
			throw new CapabilityContributionError(
				"invalid_transition",
				`cannot move ${proposal.state} to ${decision}`,
			);
		await tx`update library_curation set state = ${decision}, reviewed_by = ${reviewer}, reviewed_at = now(), review_reason = ${reason} where id = ${proposalId}`;
		if (decision === "promoted") {
			await tx`update library_items set status = 'verified-shared', version = version + 1, tx_from = now(), updated_at = now(), responsible_human = ${reviewer} where id = ${proposal.item_id}`;
			await tx`insert into current_state (kind, subject, scope, state, observed_at, seq)
				values ('registry', ${`proposal:${proposalId}`}, ${proposal.scope}, ${tx.json({ provides: [proposal.capability], transport: "library", proposal_id: proposalId, version: proposal.version, sha256: proposal.sha256, reviewed_by: reviewer, proposed_by: proposal.proposed_by })}, now(), nextval(pg_get_serial_sequence('emission_ids', 'seq')))
				on conflict (kind, subject) do update set state = excluded.state, observed_at = excluded.observed_at, seq = excluded.seq`;
		}
		return {
			schema_version: 1,
			proposal_id: proposalId,
			item_id: proposal.item_id,
			capability: proposal.capability,
			version: proposal.version,
			state: decision,
			reviewed_by: reviewer,
			reviewed_at: new Date().toISOString(),
			reason,
		};
	});
}
