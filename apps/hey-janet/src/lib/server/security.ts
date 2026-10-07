import { randomBytes } from "node:crypto";

import { error, type RequestEvent } from "@sveltejs/kit";
import { SignJWT, jwtVerify } from "jose";

import { consentSchema } from "../consent";
import type { Participant } from "./store";
const ephemeral = randomBytes(32).toString("hex");
function signingKey() {
	const secret = process.env.BOOTH_SECRET;
	if ((!secret || secret.length < 32) && process.env.NODE_ENV === "production")
		throw new Error("BOOTH_SECRET is required");
	return new TextEncoder().encode(secret ?? ephemeral);
}
export async function sign(data: Record<string, unknown>, expiry = "30d") {
	return new SignJWT(data)
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime(expiry)
		.setIssuer("hey-janet")
		.setAudience("hey-janet")
		.sign(signingKey());
}
export async function verify(token: string) {
	return (
		await jwtVerify(token, signingKey(), {
			algorithms: ["HS256"],
			issuer: "hey-janet",
			audience: "hey-janet",
		})
	).payload;
}
export async function session(event: RequestEvent): Promise<Participant> {
	try {
		const p = await verify(event.cookies.get("booth-participant") ?? "");
		if (
			typeof p.id !== "string" ||
			typeof p.name !== "string" ||
			!(p.authSub === null || typeof p.authSub === "string")
		)
			throw new Error("Invalid session");
		return { id: p.id, name: p.name, authSub: p.authSub, consent: consentSchema.parse(p.consent) };
	} catch {
		error(
			401,
			"Your session expired. Your queued takes remain on this device. Start again to reconnect.",
		);
	}
}
export interface Identity {
	sub: string;
	name: string;
	admin: boolean;
}
export async function identity(event: RequestEvent): Promise<Identity | null> {
	try {
		const p = await verify(event.cookies.get("booth-auth") ?? "");
		if (typeof p.sub !== "string") return null;
		return { sub: p.sub, name: typeof p.name === "string" ? p.name : "", admin: p.admin === true };
	} catch {
		return null;
	}
}
export async function requireAdmin(event: RequestEvent) {
	if (!(await identity(event))?.admin)
		error(403, "Sign in with Parker’s authorized PetalNet account.");
}
const buckets = new Map<string, { count: number; until: number }>();
export function limit(key: string, max: number, window = 3600000) {
	const now = Date.now();
	for (const [k, v] of buckets) if (v.until < now) buckets.delete(k);
	const b = buckets.get(key) ?? { count: 0, until: now + window };
	if (b.count >= max) error(429, "Too many requests. Please try again later.");
	b.count++;
	buckets.set(key, b);
}
export async function body(event: RequestEvent, max: number) {
	if (!event.request.body) error(400, "Missing recording");
	const reader = event.request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	async function next(): Promise<Buffer> {
		const { value, done } = await reader.read();
		if (done) return Buffer.concat(chunks);
		size += value.length;
		if (size > max) {
			await reader.cancel();
			error(413, "Recording is too large");
		}
		chunks.push(value);
		return next();
	}
	return next();
}

export async function jsonBody(event: RequestEvent, max: number): Promise<unknown> {
	try {
		return JSON.parse((await body(event, max)).toString()) as unknown;
	} catch (e) {
		if (e instanceof SyntaxError) error(400, "Malformed JSON request");
		throw e;
	}
}
