import { describe, expect, it } from "vitest";

import { ampIssuer, githubIssuer, grant, sameRepositoryPull, type Claims } from "../src/policy.ts";

const policy = {
	authentikIssuer: "https://id.petalcat.dev/application/o/turbo-cache/",
	ampWorkspaceIds: ["workspace"],
	ampProjectIds: ["project"],
};
const github = {
	iss: githubIssuer,
	sub: "job",
	repository: "PetalNet/monorepo",
	actor: "eli",
	event_name: "push",
	ref: "refs/heads/main",
};
const amp = {
	iss: ampIssuer,
	sub: "orb",
	workspace_id: "workspace",
	project_id: "project",
	token_use: "exchanged",
};

describe("GitHub policy", () => {
	it("grants main pushes read and write", () => {
		expect(grant(github, policy, false)).toBe("read write");
	});

	it("grants merge groups read and write", () => {
		expect(
			grant(
				{ ...github, event_name: "merge_group", ref: "refs/heads/gh-readonly-queue/main/pr-1" },
				policy,
				false,
			),
		).toBe("read write");
	});

	it.each([
		["foreign repository", { repository: "Elsewhere/monorepo" }],
		["feature push", { ref: "refs/heads/feature" }],
		["tag push", { ref: "refs/tags/main" }],
		["missing ref", { ref: undefined }],
		["dispatch on main", { event_name: "workflow_dispatch" }],
		["target PR", { event_name: "pull_request_target" }],
		["Dependabot update job", { event_name: "dynamic" }],
		["Dependabot push", { actor: "dependabot[bot]" }],
		["missing actor", { actor: undefined }],
		["unknown event", { event_name: "unknown" }],
		["missing event", { event_name: undefined }],
	] satisfies [string, Partial<typeof Claims.Type>][])("denies %s", (_label, changes) => {
		expect(grant({ ...github, ...changes }, policy, true)).toBeNull();
	});

	it.each(["Elsewhere/monorepo", "PetalNet/other", ""])(
		"denies merge groups in %s",
		(repository) => {
			expect(grant({ ...github, repository, event_name: "merge_group" }, policy, true)).toBeNull();
		},
	);

	it("denies Dependabot merge groups", () => {
		expect(
			grant({ ...github, actor: "dependabot[bot]", event_name: "merge_group" }, policy, true),
		).toBeNull();
	});

	it("grants proven same-repo PRs only read, even on a main ref", () => {
		expect(grant({ ...github, event_name: "pull_request" }, policy, true)).toBe("read");
	});

	it("denies PRs without same-repo proof", () => {
		expect(grant({ ...github, event_name: "pull_request" }, policy, false)).toBeNull();
	});

	it("denies Dependabot PRs", () => {
		expect(
			grant({ ...github, actor: "dependabot[bot]", event_name: "pull_request" }, policy, true),
		).toBeNull();
	});
});

describe("PR repository proof", () => {
	const pull = {
		head: { repo: { full_name: "PetalNet/monorepo" } },
		base: { repo: { full_name: "PetalNet/monorepo" } },
		user: { login: "eli" },
	};

	it("accepts matching head and base", () => {
		expect(sameRepositoryPull(pull)).toBe(true);
	});

	it("rejects a fork", () => {
		expect(sameRepositoryPull({ ...pull, head: { repo: { full_name: "fork/monorepo" } } })).toBe(
			false,
		);
	});

	it("rejects another base", () => {
		expect(sameRepositoryPull({ ...pull, base: { repo: { full_name: "PetalNet/other" } } })).toBe(
			false,
		);
	});

	it("rejects a deleted head", () => {
		expect(sameRepositoryPull({ ...pull, head: { repo: null } })).toBe(false);
	});

	it("rejects a Dependabot PR rerun by a human", () => {
		expect(sameRepositoryPull({ ...pull, user: { login: "dependabot[bot]" } })).toBe(false);
	});
});

describe("Amp policy", () => {
	it("grants allowlisted workspace and project only read", () => {
		expect(
			grant(
				{
					...amp,
					event_name: "push",
					ref: "refs/heads/main",
					repository: "PetalNet/monorepo",
				},
				policy,
				true,
			),
		).toBe("read");
	});

	it.each([
		{ workspace_id: "other" },
		{ workspace_id: undefined },
		{ project_id: "other" },
		{ project_id: undefined },
		{ token_use: "other" },
		{ token_use: undefined },
	] satisfies Partial<typeof Claims.Type>[])("denies %j", (changes) => {
		expect(grant({ ...amp, ...changes }, policy, true)).toBeNull();
	});

	it("denies empty allowlists", () => {
		expect(grant(amp, { ...policy, ampWorkspaceIds: [], ampProjectIds: [] }, true)).toBeNull();
	});
});

describe("human policy", () => {
	const human = { iss: policy.authentikIssuer, sub: "eli", groups: ["turbo-cache"] };

	it("grants members only read", () => {
		expect(grant({ ...github, ...human }, policy, true)).toBe("read");
	});

	it.each([[], ["admin"], ["turbo-cache-write"], undefined])("denies nonmembers %j", (groups) => {
		expect(grant({ ...human, groups }, policy, true)).toBeNull();
	});

	it("denies foreign issuers with a matching group", () => {
		expect(grant({ ...human, iss: "https://foreign.example" }, policy, true)).toBeNull();
	});
});
