import { z } from "zod";

export const sourceType = z.enum(["PRIMARY", "DIRECT", "DERIVED", "GUESS"]);
export const digest = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.brand<"Sha256">();

const retrievalSchema = z.object({
	url: z.url(),
	fetched_at: z.iso.datetime(),
	final_url: z.url(),
	http_status: z.number().int(),
	content_type: z.string(),
	content_encoding: z.string(),
});

const artifactFields = {
	sha256: digest,
	mime: z.string(),
	path: z.string(),
	bytes: z.number().int().nonnegative(),
};

export const artifactSchema = z.discriminatedUnion("role", [
	z.object({ ...artifactFields, role: z.literal("ORIGINAL"), retrieval: retrievalSchema }),
	z.object({ ...artifactFields, role: z.literal("DERIVED"), original_sha256: digest }),
]);
export const sourceSchema = z.object({
	schema_version: z.literal(2),
	layer: z.literal("EVIDENCE"),
	source_type: z.literal("PRIMARY"),
	id: z.string(),
	url: z.url(),
	citation_ref: z.string(),
	canonical_id: z.string(),
	title: z.string(),
	authors: z.array(z.string()),
	fetched_at: z.iso.datetime(),
	sha256: digest,
	mime: z.string(),
	access_status: z.literal("SAVED"),
	extractor: z.string(),
	artifacts: z.array(artifactSchema).min(1),
	retrieval_id: z.string(),
	previous_retrieval_id: z.string().nullable(),
	previous_sha256: digest.nullable(),
	final_url: z.url(),
	http_status: z.number().int(),
	content_type: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export interface Capture {
	canonicalId: string;
	url: string;
	title: string;
	authors: string[];
	extractor: string;
	artifacts: ({ data: Buffer; mime: string } & (
		| { role: "ORIGINAL"; retrieval: z.infer<typeof retrievalSchema> }
		| { role: "DERIVED" }
	))[];
}
export const jobSchema = z.object({
	ref: z.string(),
	state: z.enum(["QUEUED", "RUNNING", "SAVED", "INACCESSIBLE", "FAILED"]),
	attempts: z.number(),
	next_at: z.number(),
	lease_until: z.number(),
	source_id: z.string().nullable(),
	reason: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;
// oxlint-disable-next-line effecttsgo/extends-native-error -- This Node CLI does not use an Effect failure channel.
export class CaptureError extends Error {
	readonly kind: "INACCESSIBLE" | "RETRY" | "FAILED";
	readonly retryAfter: number;
	constructor(kind: CaptureError["kind"], reason: string, retryAfter = 0) {
		super(reason);
		this.kind = kind;
		this.retryAfter = retryAfter;
	}
}
// oxlint-disable-next-line effecttsgo/extends-native-error -- Distinguishes a resumable disk stop from capture failures.
export class DiskFull extends Error {}

export function normalize(ref: string): string {
	let value = ref.trim();

	if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(value)) {
		value = `doi:${decodeURIComponent(new URL(value).pathname.slice(1))}`;
	}

	if (/^(?:doi:)?10\.\d{4,9}\/\S+$/i.test(value)) {
		return `doi:${value.replace(/^doi:/i, "").toLowerCase()}`;
	}

	if (/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i.test(value)) {
		value = new URL(value).pathname.replace(/^\/(?:abs|pdf)\//, "").replace(/\.pdf$/, "");
	}

	if (/^(?:arxiv:)?(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(value)) {
		return `arxiv:${value.replace(/^arxiv:/i, "")}`;
	}

	return httpUrl(value);
}

export function httpUrl(value: string): string {
	const url = new URL(value);

	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new CaptureError(
			"FAILED",
			"Only public HTTP(S) references without credentials are accepted",
		);
	}

	if (
		[...url.searchParams.keys()].some((key) =>
			/token|secret|password|api.?key|signature|credential/i.test(key),
		)
	) {
		throw new CaptureError("FAILED", "Credential-bearing URL refused");
	}

	if (/(^|\.)(?:sci-hub|scihub|libgen|library\.lol|annas-archive)(?:\.|$)/i.test(url.hostname)) {
		throw new CaptureError("INACCESSIBLE", "Shadow-library source refused");
	}

	url.hash = "";

	return url.href;
}
