import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile, statfs, access, rm } from "node:fs/promises";
import path from "node:path";

import type { Consent } from "../consent";
import { allPrompts, prompts, maxDuration, type PromptKind } from "../prompts";
import { wavInfo } from "./wav";

export interface Participant {
	id: string;
	name: string;
	authSub: string | null;
	consent: Consent;
}
export type Decision = "undecided" | "keep" | "drop";
export interface Clip extends Pick<Participant, "id" | "name" | "consent"> {
	file: string;
	clipId: string;
	setId: string;
	kind: PromptKind;
	say: string;
	how: string;
	peak: number;
	duration: number;
	at: string;
	userAgent: string;
	deviceType: string;
	decision: Decision;
	flags: string[];
}
export const root = () => process.env.BOOTH_DATA ?? "./.cache/recordings";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function participant(
	name: string,
	authSub: string | null,
	anonymousId: string,
	consent: Consent,
): Participant {
	const id = authSub
		? createHash("sha256").update(authSub).digest("hex").slice(0, 32)
		: anonymousId;
	return { id, name, authSub, consent };
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
	const prompt: (typeof allPrompts)[number] | undefined = Number.isInteger(index)
		? allPrompts[index]
		: undefined;
	if (!prompt || !uuid.test(clipId) || !uuid.test(setId))
		throw new Error("Invalid prompt or recording identifier.");
	const allowed =
		prompt.kind === "enroll" || prompt.kind === "free"
			? p.consent.speakerRecognition
			: p.consent.wakeWord;
	if (!allowed) throw new Error("Consent is required for this recording set.");
	const info = wavInfo(bytes, maxDuration(prompt.kind));
	return serialized(async () => {
		if (
			await access(path.join(root(), ".deleted", p.id)).then(
				() => true,
				(e: unknown) => {
					if (e instanceof Error && "code" in e && e.code === "ENOENT") return false;
					throw e;
				},
			)
		)
			throw new Error("This participant was deleted. Contact Parker before recording again.");
		const dir = path.join(root(), p.id);
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
		const freeNumber = entries.reduce((next, entry) => {
			const match = /^free_(\d+)\.wav$/.exec(entry);
			return match ? Math.max(next, Number(match[1]) + 1) : next;
		}, 0);
		const file =
			prompt.kind === "free"
				? `free_${String(freeNumber).padStart(2, "0")}.wav`
				: `${prompt.kind}_${String(prompt.kind === "enroll" ? index - prompts.length : index).padStart(2, "0")}_${prompt.say
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-")
						.replace(/-$/, "")
						.slice(0, 24)}_${clipId}.wav`;
		const clip: Clip = {
			id: p.id,
			name: p.name,
			consent: p.consent,
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
				await atomic(path.join(root(), clip.id, `${clip.clipId}.clip.json`), JSON.stringify(clip));
			}),
		);
		await Promise.all([...new Set(clips.map((c) => path.join(root(), c.id)))].map(journal));
	});
}
export async function audio(clip: Clip) {
	return readFile(path.join(root(), clip.id, clip.file));
}

export async function deleteParticipant(id: string) {
	return serialized(async () => {
		const dir = path.join(root(), id);
		if (
			!(await access(dir).then(
				() => true,
				(e: unknown) => {
					if (e instanceof Error && "code" in e && e.code === "ENOENT") return false;
					throw e;
				},
			))
		)
			return false;
		await mkdir(path.join(root(), ".deleted"), { recursive: true });
		await atomic(path.join(root(), ".deleted", id), "");
		await rm(dir, { recursive: true });
		return true;
	});
}
