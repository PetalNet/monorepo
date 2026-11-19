import { Schema } from "effect";

export const githubIssuer = "https://token.actions.githubusercontent.com";
export const ampIssuer = "https://ampcode.com/api/workload-identity";
export const repository = "PetalNet/monorepo";

export const Claims = Schema.Struct({
	iss: Schema.String,
	sub: Schema.String,
	repository: Schema.optional(Schema.String),
	repository_id: Schema.optional(Schema.String),
	repository_owner_id: Schema.optional(Schema.String),
	event_name: Schema.optional(Schema.String),
	ref: Schema.optional(Schema.String),
	actor: Schema.optional(Schema.String),
	workspace_id: Schema.optional(Schema.String),
	project_id: Schema.optional(Schema.String),
	token_use: Schema.optional(Schema.String),
	groups: Schema.optional(Schema.Array(Schema.String)),
});

// Shown on the home page; keep in step with `grant` below and the README table.
export const accessTable = [
	{
		identity: "GitHub main push",
		access: "read and write",
		evidence: "Workload identity of PetalNet/monorepo (name and immutable IDs), push to main",
	},
	{
		identity: "Same-repo pull request",
		access: "read",
		evidence: "Same repository, and the GitHub API confirms the head and base are this repository",
	},
	{
		identity: "Amp orb",
		access: "read",
		evidence: "Configured workspace and project, exchanged token",
	},
	{
		identity: "Authentik user",
		access: "read",
		evidence: "Member of the turbo-cache group",
	},
	{
		identity: "Authentik writer",
		access: "read and write",
		evidence: "Member of both the turbo-cache and turbo-cache-write groups",
	},
	{
		identity: "Everything else",
		access: "denied",
		evidence: "Forks, merge groups, Dependabot, pull_request_target, invalid or expired tokens",
	},
] as const;

export interface Policy {
	readonly authentikIssuer: string;
	readonly ampWorkspaceIds: readonly string[];
	readonly ampProjectIds: readonly string[];
}

export function grant(claims: typeof Claims.Type, policy: Policy, sameRepoPull: boolean) {
	if (claims.iss === githubIssuer) {
		if (
			claims.repository !== repository ||
			claims.repository_id !== "1254675438" ||
			claims.repository_owner_id !== "217980753" ||
			!claims.actor ||
			claims.actor === "dependabot[bot]"
		) {
			return null;
		}

		if (claims.event_name === "push" && claims.ref === "refs/heads/main") {
			return "read write";
		}

		return claims.event_name === "pull_request" && sameRepoPull ? "read" : null;
	}

	if (claims.iss === ampIssuer) {
		return claims.token_use === "exchanged" &&
			claims.workspace_id !== undefined &&
			claims.project_id !== undefined &&
			policy.ampWorkspaceIds.includes(claims.workspace_id) &&
			policy.ampProjectIds.includes(claims.project_id)
			? "read"
			: null;
	}

	if (claims.iss !== policy.authentikIssuer || !claims.groups?.includes("turbo-cache")) {
		return null;
	}

	return claims.groups.includes("turbo-cache-write") ? "read write" : "read";
}

export const PullRequest = Schema.Struct({
	head: Schema.Struct({ repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })) }),
	base: Schema.Struct({ repo: Schema.Struct({ full_name: Schema.String }) }),
	user: Schema.Struct({ login: Schema.String }),
});

export function sameRepositoryPull(pull: typeof PullRequest.Type) {
	return (
		pull.head.repo?.full_name === repository &&
		pull.base.repo.full_name === repository &&
		pull.user.login !== "dependabot[bot]"
	);
}
