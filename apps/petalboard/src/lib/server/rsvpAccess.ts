import { createHash, randomBytes } from "node:crypto";

import { sendRsvpEmail, type RsvpEmailKind } from "$lib/server/email";
import { prisma } from "$lib/server/prisma";
import { EMAIL_LIMIT, IP_LIMIT, take } from "$lib/server/rateLimit";
import type { Cookies } from "@sveltejs/kit";

const RSVP_COOKIE = "pb_rsvp";
const SESSION_SECONDS = 400 * 24 * 60 * 60;
const LINK_MS = 60 * 60 * 1000;

function newToken() {
	const token = randomBytes(32).toString("base64url");

	return { token, tokenHash: hashToken(token) };
}

function hashToken(token: string) {
	return createHash("sha256").update(token).digest("hex");
}

export async function createSession(rsvpId: string, now = new Date()) {
	const { token, tokenHash } = newToken();

	await prisma.rsvpSession.create({
		data: { tokenHash, rsvpId, expiresAt: new Date(now.getTime() + SESSION_SECONDS * 1000) },
	});

	return token;
}

export async function readSession(cookies: Cookies, eventId: string, now = new Date()) {
	const token = cookies.get(RSVP_COOKIE);

	if (!token) {
		return null;
	}

	const session = await prisma.rsvpSession.findFirst({
		where: { tokenHash: hashToken(token), expiresAt: { gt: now }, rsvp: { eventId } },
		select: { rsvpId: true },
	});

	return session?.rsvpId ?? null;
}

export function setRsvpCookie(cookies: Cookies, code: string, token: string) {
	cookies.set(RSVP_COOKIE, token, {
		path: `/event/${code}`,
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		maxAge: SESSION_SECONDS,
	});
}

export function clearRsvpCookie(cookies: Cookies, code: string) {
	cookies.delete(RSVP_COOKIE, { path: `/event/${code}` });
}

async function issueLink(rsvpId: string, now = new Date()) {
	const { token, tokenHash } = newToken();

	await prisma.rsvpLink.create({
		data: { tokenHash, rsvpId, expiresAt: new Date(now.getTime() + LINK_MS) },
	});

	return token;
}

export async function consumeLink(token: string, eventId: string, now = new Date()) {
	const tokenHash = hashToken(token);
	// One conditional write, so two requests racing on the same link can't both win.
	const { count } = await prisma.rsvpLink.updateMany({
		where: { tokenHash, usedAt: null, expiresAt: { gt: now }, rsvp: { eventId } },
		data: { usedAt: now },
	});

	if (count !== 1) {
		return null;
	}

	const link = await prisma.rsvpLink.findUnique({ where: { tokenHash }, select: { rsvpId: true } });

	return link?.rsvpId ?? null;
}

/**
 * Every edit-link email goes through here, so no flow can mail an inbox past its limit. Over a
 * limit, or with no RSVP for the address, it sends nothing and says nothing.
 */
export async function sendEditLink(
	kind: RsvpEmailKind,
	rsvp: { id: string; name: string } | null,
	email: string,
	event: { title: string; publicCode: string },
	ip: string,
) {
	if (
		!take(`ip:${ip}`, IP_LIMIT.limit, IP_LIMIT.windowMs) ||
		!take(`email:${email}`, EMAIL_LIMIT.limit, EMAIL_LIMIT.windowMs) ||
		!rsvp
	) {
		return;
	}

	const token = await issueLink(rsvp.id);

	await sendRsvpEmail(kind, { email, name: rsvp.name }, event, token);
}

const inflight = new Set<Promise<void>>();

/** Runs email work after the response so its latency, or whether it ran at all, never shows. */
export function inBackground(work: () => Promise<void>) {
	const task = work()
		.catch((cause: unknown) => {
			console.error("RSVP email failed", cause);
		})
		.finally(() => {
			inflight.delete(task);
		});

	inflight.add(task);
}

/** @internal Lets tests wait for background email work. */
export async function backgroundSettled() {
	await Promise.allSettled(inflight);
}
