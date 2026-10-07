import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile, statfs } from "node:fs/promises";
import path from "node:path";

import { prompts } from "../prompts";
import { wavInfo } from "./wav";

export interface Participant {
	id: string;
	name: string;
	authSub: string | null;
}
export type Decision = "undecided" | "keep" | "drop";
export interface Clip extends Participant {
	file: string;
	clipId: string;
	setId: string;
	kind: string;
	say: string;
	how: string;
	peak: number;
	duration: number;
	at: string;
	userAgent: string;
	deviceType: string;
	participantId: string;
	participantName: string;
	decision: Decision;
	flags: string[];
}
export const root = () => process.env.BOOTH_DATA ?? "./.cache/recordings";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function participant(
	name: string,
	authSub: string | null,
	anonymousId: string,
): Participant {
	const id = authSub
		? createHash("sha256").update(authSub).digest("hex").slice(0, 32)
		: anonymousId;
	return { id, name, authSub };
}
export function folder(p: Participant) {
	return `${p.id}_${
		p.name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40) || "voice"
	}`;
}
let pending: Promise<unknown> = Promise.resolve();
function serialized<T>(job: () => Promise<T>): Promise<T> {
	const next = pending.then(job);
	pending = next.catch(() => undefined);
	return next;
}
async function atomic(file: string, body: string | Uint8Array) {
	const tmp = `${file}.${randomUUID()}.tmp`;
	await writeFile(tmp, body, { mode: 0o600 });
	await rename(tmp, file);
}
async function readClips(dir: string): Promise<Clip[]> {
	const names = (await readdir(dir)).filter((n) => n.endsWith(".clip.json"));
	return Promise.all(
		names.map(async (name) => JSON.parse(await readFile(path.join(dir, name), "utf8")) as Clip),
	);
}
export async function allClips(): Promise<Clip[]> {
	await mkdir(root(), { recursive: true, mode: 0o700 });
	const dirs = (await readdir(root(), { withFileTypes: true })).filter((d) => d.isDirectory());
	return (await Promise.all(dirs.map((dir) => readClips(path.join(root(), dir.name))))).flat();
}
async function journal(dir: string) {
	const clips = await readClips(dir);
	await atomic(
		path.join(dir, "clips.jsonl"),
		clips.map((c) => JSON.stringify(c)).join("\n") + "\n",
	);
}
export async function saveClip(
	p: Participant,
	clipId: string,
	setId: string,
	index: number,
	bytes: Uint8Array,
	userAgent: string,
) {
	const prompt: (typeof prompts)[number] | undefined = prompts.find((_, i) => i === index);
	if (!prompt || !uuid.test(clipId) || !uuid.test(setId))
		throw new Error("Invalid prompt or recording identifier.");
	const info = wavInfo(bytes);
	return serialized(async () => {
		const dir = path.join(root(), folder(p));
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const meta = path.join(dir, `${clipId}.clip.json`);
		try {
			const existing = JSON.parse(await readFile(meta, "utf8")) as Clip;
			await journal(dir);
			return existing;
		} catch (e) {
			if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
		}
		const disk = await statfs(root());
		if (disk.bavail * disk.bsize < 100_000_000)
			throw new Error("Storage is full. Your take is still saved on this device.");
		const entries = await readdir(dir);
		if (entries.filter((n) => n.endsWith(".clip.json")).length >= 4000)
			throw new Error("Participant limit reached. Contact Parker.");
		const file = `${prompt.kind}_${String(index).padStart(2, "0")}_${prompt.say
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/-$/, "")
			.slice(0, 24)}_${clipId}.wav`;
		const clip: Clip = {
			...p,
			...prompt,
			...info,
			file,
			clipId,
			setId,
			at: new Date().toISOString(),
			userAgent: userAgent.slice(0, 512),
			deviceType: /iPad|Tablet/i.test(userAgent)
				? "tablet"
				: /Mobile|Android|iPhone/i.test(userAgent)
					? "phone"
					: "desktop",
			participantId: p.id,
			participantName: p.name,
			decision: "undecided",
		};
		await atomic(path.join(dir, file), bytes);
		await atomic(meta, JSON.stringify(clip));
		await journal(dir);
		return clip;
	});
}
export async function review(ids: string[], decision: Decision) {
	return serialized(async () => {
		const clips = (await allClips()).filter((c) => ids.includes(c.clipId));
		await Promise.all(
			clips.map(async (clip) => {
				clip.decision = decision;
				await atomic(
					path.join(root(), folder(clip), `${clip.clipId}.clip.json`),
					JSON.stringify(clip),
				);
			}),
		);
		await Promise.all([...new Set(clips.map((c) => path.join(root(), folder(c))))].map(journal));
	});
}
export async function audio(clip: Clip) {
	return readFile(path.join(root(), folder(clip), clip.file));
}
