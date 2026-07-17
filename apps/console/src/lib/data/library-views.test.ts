import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildLibraryGraph, groupLibraryKanban, nextGraphNode } from "./library-views.ts";
import type { LibraryItemView, LibraryLinkFixture } from "./library.ts";

function item(id: string, kind: LibraryItemView["kind"], status: string): LibraryItemView {
	return {
		id,
		title: id,
		kind,
		project: "library",
		scope: "fleet",
		status,
		version: 1,
		updated: "1m",
		creator: "janet",
		body: "fixture",
	};
}

void describe("Library graph view model", () => {
	void it("lays a typed-link DAG out from left to right", () => {
		const items = [
			item("root", "decision", "verified-shared"),
			item("child", "doc", "draft"),
			item("leaf", "how-to", "draft"),
		];
		const links: Record<string, LibraryLinkFixture[]> = {
			root: [{ direction: "out", rel: "references", targetId: "child" }],
			child: [{ direction: "out", rel: "derived-from", targetId: "leaf" }],
		};
		const graph = buildLibraryGraph(items, links);
		const byId = new Map(graph.nodes.map((node) => [node.id, node]));
		assert.ok((byId.get("root")?.x ?? Infinity) < (byId.get("child")?.x ?? -Infinity));
		assert.ok((byId.get("child")?.x ?? Infinity) < (byId.get("leaf")?.x ?? -Infinity));
		assert.deepEqual(
			graph.edges.map(({ from, to, rel }) => [from, to, rel]),
			[
				["root", "child", "references"],
				["child", "leaf", "derived-from"],
			],
		);
	});

	void it("walks outgoing and incoming edges without falling back to DOM order", () => {
		const links: Record<string, LibraryLinkFixture[]> = {
			root: [
				{ direction: "out", rel: "references", targetId: "a" },
				{ direction: "out", rel: "references", targetId: "b" },
			],
			a: [{ direction: "in", rel: "references", targetId: "root" }],
		};
		assert.equal(nextGraphNode("root", "right", links), "a");
		assert.equal(nextGraphNode("a", "left", links), "root");
		assert.equal(nextGraphNode("root", "down", links), "b");
	});
});

void describe("Library Kanban view model", () => {
	void it("separates work and knowledge lifecycles and never buries conflicts", () => {
		const grouped = groupLibraryKanban([
			item("work", "task", "doing"),
			item("knowledge", "fact", "verified-shared"),
			item("conflict", "doc", "CONFLICT"),
			item("unclassified", "task", "blocked"),
		]);
		assert.deepEqual(
			grouped.work.doing.map(({ id }) => id),
			["work"],
		);
		assert.deepEqual(
			grouped.knowledge["verified-shared"].map(({ id }) => id),
			["knowledge"],
		);
		assert.deepEqual(
			grouped.conflicts.map(({ id }) => id),
			["conflict"],
		);
		assert.deepEqual(
			grouped.unclassified.map(({ id }) => id),
			["unclassified"],
		);
	});
});
