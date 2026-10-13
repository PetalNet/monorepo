import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

it("evicts stale files but retains recently accessed files and symlink targets", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "cache-eviction-"));
	const stale = path.join(directory, "stale");
	const hot = path.join(directory, "hot");
	const target = path.join(directory, "target");
	const link = path.join(directory, "link");

	try {
		await Promise.all([
			writeFile(stale, "stale"),
			writeFile(hot, "hot"),
			writeFile(target, "target"),
		]);

		const old = new Date(Date.now() - 15 * 86400 * 1000);

		await utimes(stale, old, old);
		await symlink(target, link);

		const result = spawnSync(
			"sh",
			[new URL("../deploy/evict.sh", import.meta.url).pathname, "--once", directory],
			{ encoding: "utf8" },
		);

		expect(result.status, result.stderr).toBe(0);
		await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(hot, "utf8")).toBe("hot");
		expect(await readFile(link, "utf8")).toBe("target");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
