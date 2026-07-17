import { createHash } from "node:crypto";

import type { Sql } from "../db/pool.ts";
import { scrubUnknown } from "../ingest/scrubber.ts";
import type { TrackerProposalLookup } from "../reads/tracker.ts";
import type { Principal } from "./principal.ts";

const MAX_TRACKER_BODY_BYTES = 24 * 1024;
const MAX_TRACKER_RESPONSE_BYTES = 64 * 1024;
const STALE_DISPATCH_MS = 30_000;

export class ProposalError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.code = code;
		this.retryable = retryable;
	}
}

export interface TrackerProposalOptions {
	readonly url: string;
	readonly token: string;
	readonly project: string;
	readonly timeoutMs?: number;
}

export interface ProposalInput {
	readonly operation: string;
	readonly requestId: string;
	readonly args: unknown;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.toSorted(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	return value;
}

function requestHash(input: ProposalInput): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(input)))
		.digest("hex");
}

export class TrackerProposalWriter {
	readonly #url: string;
	readonly #token: string;
	readonly #project: string;
	readonly #timeoutMs: number;

	constructor(options: TrackerProposalOptions) {
		this.#url = options.url;
		this.#token = options.token;
		this.#project = options.project;
		this.#timeoutMs = options.timeoutMs ?? 5_000;
	}

	get project(): string {
		return this.#project;
	}

	async file(principal: Principal, input: ProposalInput): Promise<number> {
		const scrubbed = scrubUnknown(input.args, "proposal.args");
		if (!scrubbed.ok)
			throw new ProposalError(
				"secret_detected",
				`proposal contains a secret at ${scrubbed.where ?? "proposal.args"}`,
			);
		const proposal = {
			schema_version: 1,
			request_id: input.requestId,
			proposed_by: principal.id,
			operation: input.operation,
			request_hash: requestHash(input),
			args: input.args,
		};
		const body = `Console propose-not-commit request. Owners may promote it through the normal tracker flow.\n\n\`\`\`json\n${JSON.stringify(proposal, null, 2)}\n\`\`\``;
		if (Buffer.byteLength(body) > MAX_TRACKER_BODY_BYTES)
			throw new ProposalError(
				"proposal_too_large",
				"proposal exceeds the tracker's safe request limit; split it into smaller changes",
			);
		let response: Response;
		try {
			response = await fetch(this.#url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.#token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					op: "file",
					args: {
						title: `[Proposal] ${input.operation}`.slice(0, 200),
						kind: "idea",
						project: this.#project,
						priority: 2,
						body,
					},
				}),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch {
			throw new ProposalError(
				"tracker_unavailable",
				"tracker proposal writer is unavailable",
				true,
			);
		}
		if (!response.ok)
			throw new ProposalError(
				"tracker_unavailable",
				"tracker rejected the proposal request",
				response.status >= 500 || response.status === 429,
			);
		let wire: unknown;
		try {
			const responseBody = await response.text();
			if (Buffer.byteLength(responseBody) > MAX_TRACKER_RESPONSE_BYTES)
				throw new Error("oversized tracker response");
			wire = JSON.parse(responseBody);
		} catch {
			throw new ProposalError("tracker_unavailable", "tracker returned an invalid response", true);
		}
		const taskId = (wire as { filed?: { id?: unknown } })?.filed?.id;
		if (!Number.isSafeInteger(taskId) || Number(taskId) < 1)
			throw new ProposalError("tracker_unavailable", "tracker returned an invalid task id", true);
		return Number(taskId);
	}
}

export async function proposeMutation(
	writer: Sql,
	tracker: TrackerProposalWriter,
	lookup: TrackerProposalLookup,
	principal: Principal,
	input: ProposalInput,
): Promise<Record<string, unknown>> {
	const hash = requestHash(input);
	const reconciliation = {
		requestId: input.requestId,
		principalId: principal.id,
		operation: input.operation,
		requestHash: hash,
		project: tracker.project,
	};
	interface MutationRow {
		request_hash: string;
		proposal_task_id: string | null;
		state: "ready" | "dispatching" | "complete";
		dispatch_started_at: string | Date | null;
	}
	const inserted = await writer<MutationRow[]>`
		insert into proposal_mutations (principal_id, request_id, request_hash, operation)
		values (${principal.id}, ${input.requestId}, ${hash}, ${input.operation})
		on conflict (principal_id, request_id) do nothing
		returning request_hash, proposal_task_id::text, state, dispatch_started_at`;
	let row = inserted[0];
	if (!row) {
		const existing = await writer<MutationRow[]>`
			select request_hash, proposal_task_id::text, state, dispatch_started_at
			from proposal_mutations
			where principal_id = ${principal.id} and request_id = ${input.requestId}`;
		row = existing[0];
	}
	if (!row || row.request_hash !== hash)
		throw new ProposalError("id_reused", "mutation id was already used with a different body");

	const result = (taskId: number): Record<string, unknown> => ({
		schema_version: 1,
		in_reply_to: input.requestId,
		ok: true,
		status: "applied",
		result: { proposed: true, proposal_task_id: taskId },
	});
	const complete = async (taskId: number): Promise<Record<string, unknown>> => {
		await writer`update proposal_mutations
			set proposal_task_id = ${taskId}, state = 'complete'
			where principal_id = ${principal.id} and request_id = ${input.requestId}`;
		return result(taskId);
	};
	if (row.proposal_task_id) return result(Number(row.proposal_task_id));

	// The co-located read-only tracker source is the reconciliation oracle. This closes the
	// external-success/local-failure window without ever writing tracker SQLite.
	const reconciled = lookup.findProposalTaskId(reconciliation);
	if (reconciled) return complete(reconciled);
	if (row.state === "dispatching") {
		const started = row.dispatch_started_at
			? new Date(row.dispatch_started_at).getTime()
			: Date.now();
		if (Date.now() - started < STALE_DISPATCH_MS)
			throw new ProposalError("proposal_in_flight", "proposal is still being filed", true);
		await writer`update proposal_mutations set state = 'ready', dispatch_started_at = null
			where principal_id = ${principal.id} and request_id = ${input.requestId}
			  and state = 'dispatching'`;
	}
	const claimed = await writer<{ claimed: boolean }[]>`
		update proposal_mutations set state = 'dispatching', dispatch_started_at = now()
		where principal_id = ${principal.id} and request_id = ${input.requestId} and state = 'ready'
		returning true as claimed`;
	if (!claimed[0])
		throw new ProposalError("proposal_in_flight", "proposal is still being filed", true);

	try {
		return await complete(await tracker.file(principal, input));
	} catch (error) {
		const afterFailure = lookup.findProposalTaskId(reconciliation);
		if (afterFailure) return complete(afterFailure);
		// The co-located source is synchronously consistent with the tracker writer. No matching task
		// means the effect did not commit, so this UUID may safely be retried.
		await writer`update proposal_mutations set state = 'ready', dispatch_started_at = null
			where principal_id = ${principal.id} and request_id = ${input.requestId}
			  and state = 'dispatching'`;
		throw error;
	}
}
