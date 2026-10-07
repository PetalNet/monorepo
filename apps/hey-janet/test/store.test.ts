import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prompts } from "../src/lib/prompts";
import { allClips, audio, participant, review, saveClip } from "../src/lib/server/store";
import { wavInfo } from "../src/lib/server/wav";
import { zip } from "../src/lib/server/zip";
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	delete process.env.BOOTH_DATA;
});
function wav() {
	const b = Buffer.alloc(32044);
	b.write("RIFF");
	b.writeUInt32LE(b.length - 8, 4);
	b.write("WAVEfmt ", 8);
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(1, 22);
	b.writeUInt32LE(16000, 24);
	b.writeUInt32LE(32000, 28);
	b.writeUInt16LE(2, 32);
	b.writeUInt16LE(16, 34);
	b.write("data", 36);
	b.writeUInt32LE(32000, 40);
	for (let i = 44; i < b.length; i += 2) b.writeInt16LE(Math.round(Math.sin(i / 20) * 12000), i);
	return b;
}
describe("training store", () => {
	it("preserves the 25 positive and 15 negative prompts", () => {
		expect(prompts.filter((p) => p.kind === "pos")).toHaveLength(25);
		expect(prompts.filter((p) => p.kind === "neg")).toHaveLength(15);
		expect(prompts[38].say).toBe("Say that again");
	});
	it("rejects malformed, truncated, oversized, wrong-format and too-short WAVs", () => {
		expect(wavInfo(wav()).duration).toBe(1);
		for (const b of [Buffer.from("junk"), wav().subarray(0, 100), Buffer.alloc(300000)])
			expect(() => wavInfo(b)).toThrow();
		for (const offset of [20, 22, 24, 28, 32, 34, 40]) {
			const b = wav();
			b.writeUInt16LE(99, offset);
			expect(() => wavInfo(b)).toThrow();
		}
		const short = wav().subarray(0, 1044);
		short.writeUInt32LE(1036, 4);
		short.writeUInt32LE(1000, 40);
		expect(() => wavInfo(short)).toThrow();
	});
	it("isolates same-name voices and derives stable authenticated IDs", () => {
		expect(participant("Alex", null, randomUUID()).id).not.toBe(
			participant("Alex", null, randomUUID()).id,
		);
		expect(participant("Alex", "subject", randomUUID()).id).toBe(
			participant("Alex", "subject", randomUUID()).id,
		);
	});
	it("atomically deduplicates concurrent retries and never deletes dropped audio", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "hey-janet-test-"));
		dirs.push(dir);
		process.env.BOOTH_DATA = dir;
		const p = participant("Alex", "private-oidc-subject", randomUUID()),
			id = randomUUID(),
			set = randomUUID(),
			bytes = wav();
		await Promise.all([
			saveClip(p, id, set, 0, bytes, "iPhone"),
			saveClip(p, id, set, 0, bytes, "iPhone"),
		]);
		const clips = await allClips();
		expect(clips).toHaveLength(1);
		expect(clips[0]).not.toHaveProperty("authSub");
		expect(clips[0]).not.toHaveProperty("participantId");
		expect(clips[0]).not.toHaveProperty("participantName");
		expect(clips[0]).toMatchObject({
			decision: "undecided",
			deviceType: "phone",
			duration: 1,
			name: "Alex",
		});
		await review([id], "drop");
		expect((await allClips())[0].decision).toBe("drop");
		expect(await audio(clips[0])).toEqual(bytes);
		const lines = (await readFile(path.join(dir, `${p.id}_alex`, "clips.jsonl"), "utf8"))
			.trim()
			.split("\n");
		expect(lines).toHaveLength(1);
		expect(lines.join("")).not.toContain("private-oidc-subject");
		expect(JSON.parse(lines[0])).toMatchObject({ decision: "drop" });
	});
	it("writes a standard ZIP with local and central headers", async () => {
		async function* entries() {
			yield { name: "positives/alex/pos_00.wav", data: await Promise.resolve(wav()) };
		}
		const chunks = [];
		for await (const chunk of zip(entries())) chunks.push(chunk);
		const bytes = Buffer.concat(chunks);
		expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
		expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
		expect(bytes.readUInt16LE(bytes.length - 12)).toBe(1);
	});
});
