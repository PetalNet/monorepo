import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the shared clock disposes its interval during hot-module replacement", async () => {
	const source = await readFile(new URL("./clock.svelte.ts", import.meta.url), "utf8");
	assert.match(source, /import\.meta\.hot\?\.dispose\(\(\) => clearInterval\(interval\)\)/);
});
