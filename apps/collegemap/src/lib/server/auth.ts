import { eq, and } from 'drizzle-orm';
import { db } from './db';
import { users } from './db/schema';
import type { User } from './db/schema';
import type { Cookies } from '@sveltejs/kit';

const SESSION_COOKIE = 'session';
const SESSION_SECRET = 'college-map-secret-key-change-in-production';

// Simple hash using Web Crypto API
async function sha256(message: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(message);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export async function hashPassword(password: string): Promise<string> {
	// Add salt for better security
	const salt = crypto.randomUUID();
	const hash = await sha256(salt + password);
	return `${salt}:${hash}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
	const [salt, hash] = storedHash.split(':');
	if (!salt || !hash) return false;
	const computedHash = await sha256(salt + password);
	return computedHash === hash;
}

// Simple session token: base64(userId + ':' + signature)
async function createSessionToken(userId: string): Promise<string> {
	const signature = await sha256(userId + SESSION_SECRET);
	const payload = `${userId}:${signature}`;
	return btoa(payload);
}

async function verifySessionToken(token: string): Promise<string | null> {
	try {
		const payload = atob(token);
		const [userId, signature] = payload.split(':');
		if (!userId || !signature) return null;

		const expectedSignature = await sha256(userId + SESSION_SECRET);
		if (signature !== expectedSignature) return null;

		return userId;
	} catch {
		return null;
	}
}

export async function createSession(cookies: Cookies, userId: string): Promise<void> {
	const token = await createSessionToken(userId);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: false, // Set to true in production with HTTPS
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 30 // 30 days
	});
}

export async function getSession(cookies: Cookies): Promise<User | null> {
	const token = cookies.get(SESSION_COOKIE);
	if (!token) return null;

	const userId = await verifySessionToken(token);
	if (!userId) return null;

	const user = await db.select().from(users).where(eq(users.id, userId)).get();
	return user ?? null;
}

export function clearSession(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

export async function findUserByName(
	firstName: string,
	lastName: string
): Promise<User | null> {
	const user = await db
		.select()
		.from(users)
		.where(and(eq(users.firstName, firstName), eq(users.lastName, lastName)))
		.get();
	return user ?? null;
}

export async function createUser(
	firstName: string,
	lastName: string,
	password: string
): Promise<User> {
	const passwordHash = await hashPassword(password);
	const [user] = await db
		.insert(users)
		.values({ firstName, lastName, passwordHash })
		.returning();
	return user;
}
