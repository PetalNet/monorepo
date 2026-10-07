import { requireAdmin } from "#lib/server/security.ts";
import { allClips, audio } from "#lib/server/store.ts";
import { zip } from "#lib/server/zip.ts";

import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async (event) => {
	await requireAdmin(event);
	const clips = (await allClips()).filter((c) => c.decision === "keep");
	async function* entries() {
		for (const clip of clips) {
			yield audio(clip).then((data) => ({
				name: `${clip.kind === "pos" ? "positives" : "negatives"}/${clip.file}`,
				data,
			}));
		}
		yield {
			name: "clips.jsonl",
			data: Buffer.from(clips.map((c) => JSON.stringify(c)).join("\n") + "\n"),
		};
	}
	const iterator = zip(entries());
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const item = await iterator.next();
				if (item.done) controller.close();
				else controller.enqueue(item.value);
			} catch (e) {
				controller.error(e);
			}
		},
		async cancel() {
			await iterator.return();
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": 'attachment; filename="hey-janet-kept.zip"',
		},
	});
};
