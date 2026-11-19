import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

const script = new URL("../deploy/evict.sh", import.meta.url).pathname;
const day = 86400 * 1000;

function evict(directory: string, environment: Record<string, string> = {}) {
	return spawnSync("sh", [script, "--once", directory], {
		encoding: "utf8",
		env: { ...process.env, ...environment },
	});
}

async function withDirectory(run: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(path.join(tmpdir(), "cache-eviction-"));

	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

it("evicts stale files but retains recently accessed files and symlink targets", async () => {
	await withDirectory(async (directory) => {
		const stale = path.join(directory, "stale");
		const hot = path.join(directory, "hot");
		const target = path.join(directory, "target");
		const link = path.join(directory, "link");

		await Promise.all([
			writeFile(stale, "stale"),
			writeFile(hot, "hot"),
			writeFile(target, "target"),
		]);

		const old = new Date(Date.now() - 15 * day);

		await utimes(stale, old, old);
		await symlink(target, link);

		const result = evict(directory);

		expect(result.status, result.stderr).toBe(0);
		await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(hot, "utf8")).toBe("hot");
		expect(await readFile(link, "utf8")).toBe("target");
	});
});

it("evicts oldest first down to 90% of the cap, and spares a file that was read recently", async () => {
	await withDirectory(async (directory) => {
		const now = Date.now();

		// Five 1000-byte files, written 5, 4, 3, 2 and 1 hours ago: a, b, c, d, e.
		await Promise.all(
			["a", "b", "c", "d", "e"].map(async (name, index) => {
				const file = path.join(directory, name);
				const written = new Date(now - (5 - index) * 3600 * 1000);

				await writeFile(file, "x".repeat(1000));
				await utimes(file, written, written);
			}),
		);

		// "a" is the oldest write but was read a minute ago.
		await utimes(
			path.join(directory, "a"),
			new Date(now - 60 * 1000),
			new Date(now - 5 * 3600 * 1000),
		);

		const result = evict(directory, { CACHE_MAX_BYTES: "3000" });

		expect(result.status, result.stderr).toBe(0);
		// 5000 bytes is over 3000, so evict until at most 2700 remain: b, c and d go.
		expect((await readdir(directory)).toSorted()).toEqual(["a", "e"]);
	});
});

it("leaves a cache under its cap alone", async () => {
	await withDirectory(async (directory) => {
		await writeFile(path.join(directory, "a"), "x".repeat(1000));

		const result = evict(directory, { CACHE_MAX_BYTES: "3000" });

		expect(result.status, result.stderr).toBe(0);
		expect(await readdir(directory)).toEqual(["a"]);
	});
});

it("writes a status file with the surviving totals and the last eviction time", async () => {
	await withDirectory(async (directory) => {
		const data = path.join(directory, "data");
		const status = path.join(directory, "storage.json");
		const now = Date.now();

		await mkdir(data);

		await Promise.all(
			["a", "b", "c", "d", "e"].map(async (name, index) => {
				const file = path.join(data, name);
				const written = new Date(now - (5 - index) * 3600 * 1000);

				await writeFile(file, "x".repeat(1000));
				await utimes(file, written, written);
			}),
		);

		const first = evict(data, { CACHE_MAX_BYTES: "3000", CACHE_STATUS_FILE: status });

		expect(first.status, first.stderr).toBe(0);

		const afterFirst = JSON.parse(await readFile(status, "utf8")) as Record<string, number>;

		expect(afterFirst).toMatchObject({
			files: 2,
			bytes: 2000,
			max_bytes: 3000,
			evicted_files: 3,
			evicted_bytes: 3000,
		});

		expect(afterFirst["last_eviction"]).toBeGreaterThan(0);

		// A pass that evicts nothing reports zero but keeps when eviction last happened.
		const second = evict(data, { CACHE_MAX_BYTES: "3000", CACHE_STATUS_FILE: status });

		expect(second.status, second.stderr).toBe(0);

		expect(JSON.parse(await readFile(status, "utf8"))).toMatchObject({
			files: 2,
			evicted_files: 0,
			last_eviction: afterFirst["last_eviction"],
		});
	});
});
