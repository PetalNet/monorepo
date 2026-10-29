import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import prisma from "./prisma";

const KEY_LENGTH = 64;
const SESSION_COOKIE = "session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });

  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(password: string, hash: string): boolean {
  const [saltHex, keyHex] = hash.split(":");
  if (!saltHex || !keyHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const existing = Buffer.from(keyHex, "hex");
  const computed = scryptSync(
    password.normalize("NFKC"),
    salt,
    existing.length,
    {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }
  );

  return timingSafeEqual(existing, computed);
}

export async function createSession(
  userId: string,
  cookies: Cookies
): Promise<string> {
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
  if (!sessionId) return null;

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
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
  }
  cookies.delete(SESSION_COOKIE, { path: "/" });
}
