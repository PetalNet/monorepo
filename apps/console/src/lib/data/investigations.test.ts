import { describe, expect, it } from "vitest";

import {
	ancestorTrail,
	type InvestigationNode,
	visibleInvestigationRows,
} from "./investigations.ts";

const node = (id: string, parentId: string | null): InvestigationNode => ({
	id,
	title: id,
	parentId,
	parentQuestion: null,
	panelCount: 1,
	createdBy: "janet",
	updatedAt: `2026-07-13T00:00:0${String(id.length)}Z`,
	scope: "lab",
	isHome: false,
});

describe("investigation tree", () => {
	it("lays out parentId edges and hides collapsed descendants", () => {
		const nodes = [node("root", null), node("child", "root"), node("leaf", "child")];
		expect(visibleInvestigationRows(nodes, new Set()).map(({ id, depth }) => [id, depth])).toEqual([
			["root", 0],
			["child", 1],
			["leaf", 2],
		]);
		expect(visibleInvestigationRows(nodes, new Set(["child"])).map(({ id }) => id)).toEqual([
			"root",
			"child",
		]);
	});

	it("builds a guarded ancestor breadcrumb", () => {
		const nodes = [node("root", null), node("child", "root"), node("leaf", "child")];
		expect(ancestorTrail(nodes, "leaf").map(({ id }) => id)).toEqual(["root", "child", "leaf"]);
	});
});
