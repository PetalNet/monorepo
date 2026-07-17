import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

void describe("investigation tree", () => {
	void it("lays out parentId edges and hides collapsed descendants", () => {
		const nodes = [node("root", null), node("child", "root"), node("leaf", "child")];
		assert.deepEqual(
			visibleInvestigationRows(nodes, new Set()).map(({ id, depth }) => [id, depth]),
			[
				["root", 0],
				["child", 1],
				["leaf", 2],
			],
		);
		assert.deepEqual(
			visibleInvestigationRows(nodes, new Set(["child"])).map(({ id }) => id),
			["root", "child"],
		);
	});

	void it("builds a guarded ancestor breadcrumb", () => {
		const nodes = [node("root", null), node("child", "root"), node("leaf", "child")];
		assert.deepEqual(
			ancestorTrail(nodes, "leaf").map(({ id }) => id),
			["root", "child", "leaf"],
		);
	});
});
