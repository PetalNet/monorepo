import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HistoryEntry } from "$lib/api";
import { BUILTIN_TEMPLATES } from "$lib/templates/builtin";
import { describe, expect, it } from "vitest";

import { Store } from "./store.ts";

const entry = (id: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id,
	createdAt: "2026-01-01T00:00:00.000Z",
	title: id,
	templateId: null,
	doc: BUILTIN_TEMPLATES[0].doc,
	rows: [{ label: id }],
	tapeMm: 12,
	pages: 1,
	copies: 2,
	lengthMm: 120,
	cut: true,
	chain: false,
	dryRun: false,
	status: "queued",
	...overrides,
});

describe("Store", () => {
	it("keeps data across reopening the same directory", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "ls-store-"));
		const first = new Store(dir);

		first.saveTemplate({ ...BUILTIN_TEMPLATES[1], id: "t1", name: "Mine", builtin: false });
		first.insertHistory(entry("h1"), [Uint8Array.of(1, 2, 3)]);
		first.close();

		const second = new Store(dir);

		expect(second.findTemplate("mine")?.id).toBe("t1");
		expect(second.historyPage("h1", 0)).toEqual(Uint8Array.of(1, 2, 3));
		second.close();
	});

	it("refuses a second template with the same name in any case", () => {
		const store = new Store(":memory:");
		const base = { ...BUILTIN_TEMPLATES[1], builtin: false };

		expect(store.saveTemplate({ ...base, id: "a", name: "Shelf" })).toBe(true);
		expect(store.saveTemplate({ ...base, id: "b", name: "SHELF" })).toBe(false);

		expect(
			store.saveTemplate({ ...base, id: "a", name: "shelf", description: "renamed in place" }),
		).toBe(true);

		expect(store.listTemplates().map((template) => [template.id, template.description])).toEqual([
			["a", "renamed in place"],
		]);

		expect(store.deleteTemplate("a")).toBe(true);
		expect(store.deleteTemplate("a")).toBe(false);
	});

	it("pages history newest first and round-trips every field", () => {
		const store = new Store(":memory:");

		for (const id of ["h1", "h2", "h3"]) {
			store.insertHistory(entry(id), [Uint8Array.of(9)]);
		}

		store.setHistoryStatus("h2", "failed", "Cover open");

		expect(store.listHistory(2).map((item) => item.id)).toEqual(["h3", "h2"]);
		expect(store.listHistory(2, "h2").map((item) => item.id)).toEqual(["h1"]);
		expect(store.getHistory("h2")).toEqual(entry("h2", { status: "failed", error: "Cover open" }));
		expect(store.getHistory("h1")).toEqual(entry("h1"));
	});

	it("fails jobs a previous process left unfinished", () => {
		const store = new Store(":memory:");

		store.insertHistory(entry("queued"), []);
		store.insertHistory(entry("printing", { status: "printing" }), []);
		store.insertHistory(entry("done", { status: "done" }), []);

		expect(store.failInterrupted("Interrupted")).toBe(2);

		expect(store.listHistory(10).map((item) => [item.id, item.status])).toEqual([
			["done", "done"],
			["printing", "failed"],
			["queued", "failed"],
		]);
	});
});
