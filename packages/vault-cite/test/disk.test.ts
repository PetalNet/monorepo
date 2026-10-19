import type * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { Cite, Store } from "../src/index.ts";
import { diskGuard } from "../src/store.ts";
const capacity = vi.hoisted(() => ({ bytes: 40 * 1024 ** 3 }));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof fs>()),
	statfsSync: () => ({ bavail: capacity.bytes, bsize: 1 }),
}));

afterEach(() => {
	capacity.bytes = 40 * 1024 ** 3;
});

it("stops before a write would cross the 35 GiB floor", () => {
	capacity.bytes = 35 * 1024 ** 3;

	expect(() => {
		diskGuard(process.cwd(), 1);
	}).toThrow("35 GiB");

	expect(() => {
		diskGuard(process.cwd(), 0);
	}).not.toThrow();
});

it("reports a disk stop without claiming queued work", async () => {
	const root = mkdtempSync(path.join(process.cwd(), ".cite-disk-"));
	const store = new Store(root);

	try {
		store.enqueue("arxiv:1706.03762");
		capacity.bytes = 34 * 1024 ** 3;
		expect(await new Cite(store).work()).toMatchObject({ processed: 0, saved: 0, stopped: true });
		expect(store.job("arxiv:1706.03762")?.state).toBe("QUEUED");
	} finally {
		store.close();
		rmSync(root, { recursive: true });
	}
});
