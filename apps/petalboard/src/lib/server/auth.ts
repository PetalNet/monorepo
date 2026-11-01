import type { Cookies } from "@sveltejs/kit";

import { prisma } from "./prisma";

const SESSION_COOKIE = "session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(userId: string, cookies: Cookies): Promise<string> {
	const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

	const session = await prisma.session.create({
		data: {
			userId,
			expiresAt,
		},
	});

	cookies.set(SESSION_COOKIE, session.id, {
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		secure: process.env.NODE_ENV === "production",
		expires: expiresAt,
	});

	return session.id;
}

export async function getSessionUser(cookies: Cookies) {
	const sessionId = cookies.get(SESSION_COOKIE);

	if (!sessionId) {
		return null;
	}

	const session = await prisma.session.findUnique({
		where: { id: sessionId },
		include: { user: true },
	});

	if (!session || session.expiresAt < new Date()) {
		if (session) {
			await prisma.session.delete({ where: { id: sessionId } });
		}

		cookies.delete(SESSION_COOKIE, { path: "/" });

		return null;
	}

	return session.user;
}

export async function deleteSession(cookies: Cookies): Promise<void> {
	const sessionId = cookies.get(SESSION_COOKIE);

	if (sessionId) {
		// deleteMany tolerates a session that is already gone.
		await prisma.session.deleteMany({ where: { id: sessionId } });
	}

	cookies.delete(SESSION_COOKIE, { path: "/" });
}
