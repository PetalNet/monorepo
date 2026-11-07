import { tapeGeometry } from "$lib/doc";
import { emptyDoc } from "$lib/editor/model";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWorker() {
	let listener: ((event: { data: unknown }) => void) | undefined;
	const posted: unknown[] = [];

	vi.stubGlobal("addEventListener", (type: string, handler: typeof listener) => {
		if (type === "message") {
			listener = handler;
		}
	});

	vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
	vi.resetModules();
	await import("./render.worker.ts");

	return {
		posted,
		send: async (data: unknown) => {
			listener?.({ data });

			await new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("render worker", () => {
	it("answers a render request with its id", async () => {
		const worker = await loadWorker();

		await worker.send({ id: 7, doc: emptyDoc(12), options: { tape: tapeGeometry(12) } });

		expect(worker.posted).toHaveLength(1);
		expect(worker.posted[0]).toHaveProperty("id", 7);
		expect(worker.posted[0]).toHaveProperty("result.frame");
	});

	it.each([
		null,
		"render",
		{ id: "7" },
		{ id: 7, doc: {}, options: {} },
		{ id: 7, doc: emptyDoc(12) },
	])("drops a message that is not a render request: %j", async (data) => {
		const worker = await loadWorker();

		await worker.send(data);

		expect(worker.posted).toEqual([]);
	});
});
