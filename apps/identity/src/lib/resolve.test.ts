import { describe, expect, it } from "vitest";

import { explainAccess, renderExplanation, type RoleGraph } from "./resolve";

/**
 * The tests drive the public API only: `explainAccess` and `renderExplanation`. Role walking and
 * cycle detection are reached through them, which is how a caller reaches them too, so these
 * assertions survive the internals being rewritten.
 */
const reachable = (graph: RoleGraph, roleIds: string[]) =>
	explainAccess(graph, roleIds, "\u0000no-such-resource").reachable;

/** Cycles surface as a throw from any resolution against the broken graph. */
const resolveAgainst = (graph: RoleGraph, roleIds: string[]) => () =>
	explainAccess(graph, roleIds, "jellyfin");

/**
 * The lab's actual role shape, so these tests fail on real mistakes rather than toy ones:
 * Owner -> Admin -> Friends -> Media, plus two side roles that inherit nothing.
 */
function labGraph(overrides: Partial<RoleGraph> = {}): RoleGraph {
	const roles = new Map(
		[
			{ id: "owner", name: "Owner", inherits: ["admin"] },
			{ id: "admin", name: "Admin", inherits: ["friends"] },
			{ id: "friends", name: "Friends", inherits: ["media"] },
			{ id: "media", name: "Media", inherits: [] },
			{ id: "glovebox-admin", name: "Glovebox Admin", inherits: [] },
			{ id: "college-student", name: "College Student", inherits: [] },
		].map((role) => [role.id, role]),
	);
	return {
		roles,
		grants: [
			{ roleId: "media", resourceId: "jellyfin" },
			{ roleId: "friends", resourceId: "petalnotes" },
			{ roleId: "admin", resourceId: "grafana" },
			{ roleId: "owner", resourceId: "paperless" },
			{ roleId: "glovebox-admin", resourceId: "glovebox" },
		],
		denies: [],
		...overrides,
	};
}

describe("reachableRoles", () => {
	it("walks the whole inheritance chain from a single directly-held role", () => {
		const steps = reachable(labGraph(), ["owner"]);
		expect(steps.map((s) => s.roleId)).toEqual(["owner", "admin", "friends", "media"]);
		expect(steps.map((s) => s.distance)).toEqual([0, 1, 2, 3]);
	});

	it("records the path taken, not just the destination", () => {
		const media = reachable(labGraph(), ["owner"]).find((s) => s.roleId === "media");
		expect(media?.path).toEqual(["owner", "admin", "friends", "media"]);
	});

	it("treats a role held both directly and by inheritance as direct", () => {
		// Cooper holds Media directly AND Glovebox Admin. Media must stay distance 0: whether a
		// role is direct decides the tier it competes in, so getting this wrong silently changes
		// which grant wins.
		const steps = reachable(labGraph(), ["media", "glovebox-admin"]);
		expect(steps.find((s) => s.roleId === "media")?.distance).toBe(0);
	});

	it("reaches a diamond only once, by its shortest path", () => {
		const graph = labGraph();
		graph.roles.set("moderator", { id: "moderator", name: "Moderator", inherits: ["media"] });
		const steps = reachable(graph, ["friends", "moderator"]);
		expect(steps.filter((s) => s.roleId === "media")).toHaveLength(1);
		expect(steps.find((s) => s.roleId === "media")?.distance).toBe(1);
	});

	it("ignores references to roles that do not exist rather than inventing them", () => {
		const graph = labGraph();
		graph.roles.set("ghost", { id: "ghost", name: "Ghost", inherits: ["does-not-exist"] });
		expect(reachable(graph, ["ghost"]).map((s) => s.roleId)).toEqual(["ghost"]);
	});

	it("returns nothing for a subject with no roles", () => {
		expect(reachable(labGraph(), [])).toEqual([]);
	});
});

describe("cycle detection", () => {
	it("throws rather than looping when a role inherits itself transitively", () => {
		const graph = labGraph();
		graph.roles.set("media", { id: "media", name: "Media", inherits: ["owner"] });
		expect(resolveAgainst(graph, ["owner"])).toThrow(/inheritance cycle/i);
	});

	it("names the cycle so it can be fixed", () => {
		const graph = labGraph();
		graph.roles.set("media", { id: "media", name: "Media", inherits: ["owner"] });
		try {
			explainAccess(graph, ["owner"], "jellyfin");
			expect.unreachable("should have thrown");
		} catch (error) {
			// The message has to name the roles: a cycle error that does not say which roles are
			// involved leaves someone diffing a role graph by hand.
			expect((error as Error).message).toContain("owner -> admin -> friends -> media -> owner");
		}
	});

	it("catches a self-inheriting role", () => {
		const graph = labGraph();
		graph.roles.set("media", { id: "media", name: "Media", inherits: ["media"] });
		expect(resolveAgainst(graph, ["media"])).toThrow(/inheritance cycle/i);
	});

	it("catches a cycle in a branch nobody holds", () => {
		// A cycle in an unreachable branch is still a broken graph, and it will bite the moment
		// somebody is given that role. Finding it only on assignment would be too late.
		const graph = labGraph();
		graph.roles.set("a", { id: "a", name: "A", inherits: ["b"] });
		graph.roles.set("b", { id: "b", name: "B", inherits: ["a"] });
		expect(resolveAgainst(graph, ["owner"])).toThrow(/inheritance cycle/i);
	});

	it("does not mistake a diamond for a cycle", () => {
		const graph = labGraph();
		graph.roles.set("moderator", { id: "moderator", name: "Moderator", inherits: ["media"] });
		graph.roles.set("staff", { id: "staff", name: "Staff", inherits: ["moderator", "friends"] });
		expect(resolveAgainst(graph, ["staff"])).not.toThrow();
	});
});

describe("explainAccess", () => {
	it("allows through inheritance and names the role that granted it", () => {
		const result = explainAccess(labGraph(), ["owner"], "jellyfin");
		expect(result.decision).toBe("allow");
		expect(result.reason).toBe("inherited-allow");
		expect(result.deciding?.roleId).toBe("media");
		expect(result.deciding?.path).toEqual(["owner", "admin", "friends", "media"]);
	});

	it("distinguishes a direct allow from an inherited one", () => {
		expect(explainAccess(labGraph(), ["media"], "jellyfin").reason).toBe("direct-allow");
		expect(explainAccess(labGraph(), ["friends"], "jellyfin").reason).toBe("inherited-allow");
	});

	it("denies by default when nothing grants the resource", () => {
		const result = explainAccess(labGraph(), ["media"], "paperless");
		expect(result.decision).toBe("deny");
		expect(result.reason).toBe("default-deny");
		expect(result.deciding).toBeNull();
	});

	it("lets an explicit deny beat an inherited allow", () => {
		// The whole reason denies exist: Friends inherits Media, Media grants Jellyfin, but this
		// Friends must not have Jellyfin. Without deny you would have to clone Media.
		const graph = labGraph({ denies: [{ roleId: "friends", resourceId: "jellyfin" }] });
		const result = explainAccess(graph, ["friends"], "jellyfin");
		expect(result.decision).toBe("deny");
		expect(result.reason).toBe("explicit-direct-deny");
	});

	it("lets an inherited deny beat a direct allow", () => {
		// Deny wins at every distance, not just when it is closer. If allow could win by being
		// nearer, a deny placed high in the tree would be silently defeated by any leaf grant,
		// and an exception carved at the top would not hold.
		const graph = labGraph({
			grants: [{ roleId: "friends", resourceId: "accounting" }],
			denies: [{ roleId: "media", resourceId: "accounting" }],
		});
		const result = explainAccess(graph, ["friends"], "accounting");
		expect(result.decision).toBe("deny");
		expect(result.reason).toBe("inherited-deny");
	});

	it("reports what the deny overrode, so the denial is actionable", () => {
		const graph = labGraph({ denies: [{ roleId: "admin", resourceId: "jellyfin" }] });
		const result = explainAccess(graph, ["owner"], "jellyfin");
		expect(result.decision).toBe("deny");
		expect(result.overruled.map((s) => s.roleId)).toEqual(["media"]);
	});

	it("picks the closest deny when several apply", () => {
		const graph = labGraph({
			denies: [
				{ roleId: "media", resourceId: "jellyfin" },
				{ roleId: "owner", resourceId: "jellyfin" },
			],
		});
		expect(explainAccess(graph, ["owner"], "jellyfin").deciding?.roleId).toBe("owner");
	});

	it("is deterministic when two roles tie at the same distance", () => {
		const graph = labGraph({
			grants: [
				{ roleId: "glovebox-admin", resourceId: "shared" },
				{ roleId: "college-student", resourceId: "shared" },
			],
		});
		const first = explainAccess(graph, ["glovebox-admin", "college-student"], "shared");
		const second = explainAccess(graph, ["college-student", "glovebox-admin"], "shared");
		expect(first.deciding?.roleId).toBe(second.deciding?.roleId);
		expect(first.deciding?.roleId).toBe("college-student");
	});

	it("denies a subject with no roles at all", () => {
		expect(explainAccess(labGraph(), [], "jellyfin").decision).toBe("deny");
	});
});

describe("the spec's own worked examples", () => {
	it("answers 'why can Parker access Grafana' with Owner -> Admin -> Grafana", () => {
		const result = explainAccess(labGraph(), ["owner"], "grafana");
		expect(result.decision).toBe("allow");
		expect(result.deciding?.path).toEqual(["owner", "admin"]);
	});

	it("answers 'why can Cooper not access Paperless' with a default deny", () => {
		const result = explainAccess(labGraph(), ["media", "glovebox-admin"], "paperless");
		expect(result.decision).toBe("deny");
		expect(result.reason).toBe("default-deny");
		expect(result.reachable.map((s) => s.roleId)).toEqual(["media", "glovebox-admin"]);
	});

	it("computes what Cooper gains from Friends, which is the defining interaction", () => {
		const graph = labGraph();
		const before = ["media", "glovebox-admin"];
		const after = [...before, "friends"];
		const resources = ["jellyfin", "petalnotes", "grafana", "paperless", "glovebox"];

		const decide = (roles: string[]) =>
			Object.fromEntries(resources.map((r) => [r, explainAccess(graph, roles, r).decision]));

		const gained = resources.filter(
			(r) => decide(before)[r] === "deny" && decide(after)[r] === "allow",
		);
		const kept = resources.filter(
			(r) => decide(before)[r] === "allow" && decide(after)[r] === "allow",
		);
		const stillDenied = resources.filter((r) => decide(after)[r] === "deny");

		expect(gained).toEqual(["petalnotes"]);
		expect(kept).toEqual(["jellyfin", "glovebox"]);
		expect(stillDenied).toEqual(["grafana", "paperless"]);
	});
});

describe("who reaches a resource", () => {
	it("is answerable per subject through the public API", () => {
		const graph = labGraph();
		const subjects = [
			{ id: "parker", roleIds: ["owner"] },
			{ id: "elisha", roleIds: ["admin"] },
			{ id: "cooper", roleIds: ["media", "glovebox-admin"] },
		];
		const allowed = subjects.filter(
			(s) => explainAccess(graph, s.roleIds, "grafana").decision === "allow",
		);
		expect(allowed.map((s) => s.id)).toEqual(["parker", "elisha"]);
	});

	it("excludes someone whose allow is overridden by a deny", () => {
		const graph = labGraph({ denies: [{ roleId: "admin", resourceId: "grafana" }] });
		expect(explainAccess(graph, ["admin"], "grafana").decision).toBe("deny");
	});
});

describe("renderExplanation", () => {
	it("renders the granting path as a tree", () => {
		const result = explainAccess(labGraph(), ["owner"], "grafana");
		expect(renderExplanation(result, "Parker")).toBe(
			[
				"Parker",
				"  holds owner",
				"    inherits admin",
				"      grants access",
				"RESULT: ALLOW (inherited-allow)",
			].join("\n"),
		);
	});

	it("renders a default deny by showing what the subject does hold", () => {
		const result = explainAccess(labGraph(), ["media"], "paperless");
		const rendered = renderExplanation(result, "Cooper");
		expect(rendered).toContain("holds media");
		expect(rendered).toContain("RESULT: DENY (default-deny)");
	});
});
