import { error } from "@sveltejs/kit";

import { requireAdmin } from "#lib/server/security.ts";
import { allClips, audio, participantFolder } from "#lib/server/store.ts";
import { zip } from "#lib/server/zip.ts";

import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async (event) => {
	await requireAdmin(event);
	const set = event.url.searchParams.get("set") ?? "wake";
	if (set !== "wake" && set !== "speaker") error(400, "Choose a wake-word or speaker-ID set.");
	const speaker = set === "speaker";
	const clips = (await allClips()).filter(
		(c) =>
			c.decision === "keep" &&
			(speaker ? c.kind === "enroll" || c.kind === "free" : c.kind === "pos" || c.kind === "neg"),
	);
	const groups = speaker ? Map.groupBy(clips, participantFolder) : new Map([["", clips]]);
	async function* entries() {
		for (const [directory, participants] of groups) {
			for (const clip of participants) {
				yield audio(clip).then((data) => ({
					name: speaker
						? `${directory}/${clip.file}`
						: `${clip.kind === "pos" ? "positives" : "negatives"}/${clip.file}`,
					data,
				}));
			}
			yield {
				name: `${directory ? directory + "/" : ""}clips.jsonl`,
				data: Buffer.from(participants.map((c) => JSON.stringify(c)).join("\n") + "\n"),
			};
		}
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
			"Content-Disposition": `attachment; filename="hey-janet-${set}.zip"`,
		},
	});
};
