import { createHash } from "node:crypto";

import { z } from "zod";

import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";
import { parseCapabilityBundle } from "./loader.ts";

const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

export const capabilityAcquisitionSchema = z
	.object({
		schema_version: z.literal(1),
		capability: z.string().min(1),
		kind: z.enum(["skill", "tool"]),
		version: z.string().min(1),
		provider: z.string().min(1),
		scope: z.string().min(1),
		integrity: z
			.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/) })
			.passthrough(),
		artifact: z
			.object({
				media_type: z.literal("application/vnd.petalnet.capability-bundle+json"),
				encoding: z.literal("base64"),
				bytes: z
					.number()
					.int()
					.positive()
					.max(2 * 1024 * 1024),
				data: z.string(),
			})
			.passthrough(),
		provenance: z
			.object({
				library_item_id: z.string(),
				library_item_version: z.number().int().positive(),
				created_by_agent: z.string().nullable(),
				responsible_human: z.string().nullable(),
				source_url: z.string().nullable(),
				registry_observed_at: z.string().datetime(),
			})
			.passthrough(),
	})
	.passthrough();

export type CapabilityAcquisition = z.infer<typeof capabilityAcquisitionSchema>;

interface AcquisitionRow {
	provider: string;
	scope: string;
	registry_state: Record<string, unknown>;
	observed_at: string | Date;
	item_id: string;
	item_kind: string;
	status: string;
	body_ref: string;
	properties: Record<string, unknown>;
	version_number: number;
	created_by: string | null;
	responsible_human: string | null;
	source_url: string | null;
	blob_scope: string;
	bytes: Buffer;
}

export type CapabilityAcquisitionErrorCode =
	| "bad_capability"
	| "capability_not_found"
	| "capability_artifact_invalid";

export class CapabilityAcquisitionError extends Error {
	readonly code: CapabilityAcquisitionErrorCode;

	constructor(code: CapabilityAcquisitionErrorCode, message: string) {
		super(message);
		this.name = "CapabilityAcquisitionError";
		this.code = code;
	}
}

function advertised(state: Record<string, unknown>, capability: string): boolean {
	const raw = state["provides"] ?? state["capabilities"] ?? [];
	if (Array.isArray(raw)) return raw.some((value) => value === capability);
	return typeof raw === "string" && raw.split(",").some((value) => value.trim() === capability);
}

function propertyString(properties: Record<string, unknown>, key: string): string | null {
	const value = properties[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve through both scope-protected seams. A registry advertisement alone cannot yield bytes,
 * and an orphaned Library artifact is not discoverable as a fleet capability.
 */
export async function acquireCapability(
	app: Sql,
	scopes: readonly string[],
	capability: string,
	provider?: string,
): Promise<CapabilityAcquisition> {
	if (!CAPABILITY_PATTERN.test(capability) || (provider && !PROVIDER_PATTERN.test(provider)))
		throw new CapabilityAcquisitionError("bad_capability", "capability or provider is invalid");
	const rows = await withScopes(
		app,
		scopes,
		async (tx) => tx<AcquisitionRow[]>`
			select r.subject as provider, r.scope, r.state as registry_state, r.observed_at,
			       i.id as item_id, i.kind as item_kind, i.status, i.body_ref,
			       i.properties, i.version as version_number, i.created_by,
			       i.responsible_human, i.source_url, b.scope as blob_scope, b.bytes
			from current_state r
			join library_items i
			  on i.scope = r.scope and i.properties->>'capability' = ${capability}
			join blobs b on b.id = i.body_ref and b.scope = i.scope
			where r.kind = 'registry'
			  and (${provider ?? null}::text is null or r.subject = ${provider ?? null})
			  and i.kind = 'artifact' and i.status = 'verified-shared'
			  and i.properties->>'artifact_type' = 'capability'
			order by r.observed_at desc, i.version desc, i.id
			limit 20`,
	);
	const row = rows.find((candidate) => advertised(candidate.registry_state, capability));
	if (!row)
		throw new CapabilityAcquisitionError(
			"capability_not_found",
			"capability is not available in the caller's scopes",
		);
	const kind = propertyString(row.properties, "capability_kind");
	const version = propertyString(row.properties, "version");
	if ((kind !== "skill" && kind !== "tool") || !version)
		throw new CapabilityAcquisitionError(
			"capability_artifact_invalid",
			"capability artifact metadata is incomplete",
		);
	const digest = createHash("sha256").update(row.bytes).digest("hex");
	const declaredDigest = propertyString(row.properties, "sha256");
	if (!declaredDigest || !/^[a-f0-9]{64}$/.test(declaredDigest) || declaredDigest !== digest)
		throw new CapabilityAcquisitionError(
			"capability_artifact_invalid",
			"capability artifact integrity does not match its Library record",
		);
	try {
		parseCapabilityBundle(row.bytes, { algorithm: "sha256", digest });
	} catch {
		throw new CapabilityAcquisitionError(
			"capability_artifact_invalid",
			"capability artifact bundle is not runnable",
		);
	}
	return {
		schema_version: 1,
		capability,
		kind,
		version,
		provider: row.provider,
		scope: row.scope,
		integrity: { algorithm: "sha256", digest },
		artifact: {
			media_type: "application/vnd.petalnet.capability-bundle+json",
			encoding: "base64",
			bytes: row.bytes.length,
			data: row.bytes.toString("base64"),
		},
		provenance: {
			library_item_id: row.item_id,
			library_item_version: row.version_number,
			created_by_agent: row.created_by,
			responsible_human: row.responsible_human,
			source_url: row.source_url,
			registry_observed_at: new Date(row.observed_at).toISOString(),
		},
	};
}
