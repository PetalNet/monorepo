import { describe, expect, it } from "vitest";

import type { RoleGraph } from "../resolve";
import { impactLevel, simulate, type RoleChange } from "./changes";
import type { LabState } from "./state";

/** The lab's real role shape and a slice of its real applications. */
function state(): LabState {
	const roles = new Map(
		[
			{ id: "owner", name: "Owner", inherits: ["admin"] },
			{ id: "admin", name: "Admin", inherits: ["friends"] },
			{ id: "friends", name: "Friends", inherits: ["media"] },
			{ id: "media", name: "Media", inherits: [] },
			{ id: "glovebox-admins", name: "Glovebox Admin", inherits: [] },
		].map((role) => [role.id, role]),
	);

	const roleGraph: RoleGraph = {
		roles,
		grants: [
			{ roleId: "media", resourceId: "jellyfin" },
			{ roleId: "friends", resourceId: "petalnotes" },
			{ roleId: "friends", resourceId: "ideas" },
			{ roleId: "friends", resourceId: "homepage" },
			{ roleId: "admin", resourceId: "grafana" },
			{ roleId: "owner", resourceId: "paperless" },
			{ roleId: "owner", resourceId: "dawarich" },
			{ roleId: "glovebox-admins", resourceId: "glovebox" },
		],
		denies: [],
	};

	const slugs = [
		"jellyfin",
		"petalnotes",
		"ideas",
		"homepage",
		"grafana",
		"paperless",
		"dawarich",
		"glovebox",
	];

	return {
		people: [
			{
				id: "cooper",
				pk: 1,
				username: "cooper",
				displayName: "Cooper",
				email: "",
				roleIds: ["media", "glovebox-admins"],
				unmappedGroups: [],
			},
			{
				id: "parker",
				pk: 2,
				username: "parker",
				displayName: "Parker",
				email: "",
				roleIds: ["owner"],
				unmappedGroups: [],
			},
			{
				id: "lola",
				pk: 3,
				username: "lola",
				displayName: "Lola",
				email: "",
				roleIds: ["media"],
				unmappedGroups: [],
			},
		],
		machines: [],
		resources: slugs.map((slug) => ({ slug, name: slug, boundTo: ["x"], unbound: false })),
		roleGraph,
		findings: [],
		gate: { blocked: false, reason: "", unboundApplications: [] },
		error: null,
		readAt: "2026-08-12T00:00:00.000Z",
	};
}

const give = (personId: string, roleId: string): RoleChange => ({
	kind: "add-role",
	personId,
	roleId,
});
const take = (personId: string, roleId: string): RoleChange => ({
	kind: "remove-role",
	personId,
	roleId,
});

describe("simulate", () => {
	it("computes the defining interaction: give Cooper Friends", () => {
		const impact = simulate(state(), give("cooper", "friends"));
		expect(impact.gains).toEqual(["petalnotes", "ideas", "homepage"]);
		expect(impact.keeps).toEqual(["jellyfin", "glovebox"]);
		expect(impact.loses).toEqual([]);
		expect(impact.stillDenied).toEqual(["grafana", "paperless", "dawarich"]);
	});

	it("reports what a removal takes away", () => {
		const impact = simulate(state(), take("parker", "owner"));
		expect(impact.loses).toContain("paperless");
		expect(impact.loses).toContain("dawarich");
		expect(impact.gains).toEqual([]);
	});

	it("says nothing changes when the role is already held", () => {
		const impact = simulate(state(), give("cooper", "media"));
		expect(impact.gains).toEqual([]);
		expect(impact.loses).toEqual([]);
	});

	it("says nothing changes when removing a role they do not hold", () => {
		const impact = simulate(state(), take("lola", "admin"));
		expect(impact.gains).toEqual([]);
		expect(impact.loses).toEqual([]);
	});

	it("follows inheritance, so a high role grants the whole chain", () => {
		const impact = simulate(state(), give("lola", "owner"));
		expect(impact.gains).toEqual([
			"petalnotes",
			"ideas",
			"homepage",
			"grafana",
			"paperless",
			"dawarich",
		]);
		expect(impact.keeps).toEqual(["jellyfin"]);
	});

	it("returns an empty impact for someone who does not exist, rather than throwing", () => {
		const impact = simulate(state(), give("nobody", "friends"));
		expect(impact).toEqual({
			gains: [],
			keeps: [],
			loses: [],
			stillDenied: [],
			postconditions: [],
		});
	});
});

describe("postconditions", () => {
	it("asserts the gains as allows", () => {
		const { postconditions } = simulate(state(), give("cooper", "friends"));
		for (const slug of ["petalnotes", "ideas", "homepage"]) {
			expect(postconditions).toContainEqual({ resourceId: slug, expect: "allow" });
		}
	});

	it("also asserts things that must NOT change", () => {
		// Checking only the gains would let a change that accidentally opened something else pass
		// as verified. The denies are what make this a test rather than a formality.
		const { postconditions } = simulate(state(), give("cooper", "friends"));
		const denies = postconditions.filter((p) => p.expect === "deny").map((p) => p.resourceId);
		expect(denies).toContain("grafana");
		expect(denies).toContain("paperless");
	});

	it("asserts a removal as a deny", () => {
		const { postconditions } = simulate(state(), take("parker", "owner"));
		expect(postconditions).toContainEqual({ resourceId: "paperless", expect: "deny" });
	});

	it("produces nothing to assert for a no-op change beyond the deny sample", () => {
		const { postconditions } = simulate(state(), give("cooper", "media"));
		expect(postconditions.every((p) => p.expect === "deny")).toBe(true);
	});
});

describe("unbound applications are excluded from postconditions", () => {
	/**
	 * Found by driving a real change through the UI. An unbound application admits every
	 * authenticated account, so intended=deny and evaluated=allow for everyone regardless of the
	 * change under test. Asserting on it marked an otherwise-correct change "not verified" and would
	 * have trained the operator to ignore the red banner.
	 */
	function withUnbound(): LabState {
		const base = state();
		return {
			...base,
			resources: base.resources.map((r) =>
				r.slug === "dawarich" ? { ...r, unbound: true, boundTo: [] } : r,
			),
		};
	}

	it("does not assert deny on an application that admits everyone", () => {
		const { postconditions } = simulate(withUnbound(), give("cooper", "friends"));
		expect(postconditions.map((p) => p.resourceId)).not.toContain("dawarich");
	});

	it("still asserts deny on applications that are actually bound", () => {
		// The positive control: if the filter removed everything, the absence above would prove
		// nothing. Bound resources must survive it.
		const { postconditions } = simulate(withUnbound(), give("cooper", "friends"));
		const denies = postconditions.filter((p) => p.expect === "deny").map((p) => p.resourceId);
		expect(denies).toContain("grafana");
		expect(denies.length).toBeGreaterThan(0);
	});

	it("still asserts the gains", () => {
		const { postconditions } = simulate(withUnbound(), give("cooper", "friends"));
		expect(postconditions).toContainEqual({ resourceId: "petalnotes", expect: "allow" });
	});
});

describe("impactLevel", () => {
	it("treats a small change as normal", () => {
		expect(impactLevel(simulate(state(), give("cooper", "glovebox-admins")))).toBe("normal");
	});

	it("treats a three-resource change as significant", () => {
		expect(impactLevel(simulate(state(), give("cooper", "friends")))).toBe("significant");
	});

	it("treats anything touching a sensitive resource as dangerous, however small", () => {
		// One resource, but it is the finances. Size is the wrong axis on its own.
		const impact = {
			gains: ["firefly"],
			keeps: [],
			loses: [],
			stillDenied: [],
			postconditions: [],
		};
		expect(impactLevel(impact)).toBe("dangerous");
	});

	it("treats a wide change as dangerous even when nothing sensitive is in it", () => {
		expect(impactLevel(simulate(state(), give("lola", "owner")))).toBe("dangerous");
	});
});
