import { Column, Table } from "effect-qb";

const identifier = () => Column.text();
const timestamp = () => Column.timestamp();

export const users = Table.make("user", {
	id: identifier().pipe(Column.primaryKey),
	name: Column.text(),
	email: Column.text().pipe(Column.unique),
	emailVerified: Column.boolean(),
	image: Column.text().pipe(Column.nullable),
	createdAt: timestamp(),
	updatedAt: timestamp(),
	tier: Column.text(),
});

export const sessions = Table.make("session", {
	id: identifier().pipe(Column.primaryKey),
	userId: identifier(),
	token: Column.text().pipe(Column.unique),
	expiresAt: timestamp(),
	ipAddress: Column.text().pipe(Column.nullable),
	userAgent: Column.text().pipe(Column.nullable),
	createdAt: timestamp(),
	updatedAt: timestamp(),
});

export const accounts = Table.make("account", {
	id: identifier().pipe(Column.primaryKey),
	userId: identifier(),
	accountId: Column.text(),
	providerId: Column.text(),
	accessToken: Column.text().pipe(Column.nullable),
	refreshToken: Column.text().pipe(Column.nullable),
	accessTokenExpiresAt: timestamp().pipe(Column.nullable),
	refreshTokenExpiresAt: timestamp().pipe(Column.nullable),
	scope: Column.text().pipe(Column.nullable),
	idToken: Column.text().pipe(Column.nullable),
	password: Column.text().pipe(Column.nullable),
	createdAt: timestamp(),
	updatedAt: timestamp(),
});

export const verifications = Table.make("verification", {
	id: identifier().pipe(Column.primaryKey),
	identifier: Column.text(),
	value: Column.text(),
	expiresAt: timestamp(),
	createdAt: timestamp(),
	updatedAt: timestamp(),
});

export const tiers = Table.make("tier", {
	id: identifier().pipe(Column.primaryKey),
	name: Column.text().pipe(Column.unique),
	description: Column.text(),
	proposeOnly: Column.boolean(),
	createdAt: timestamp(),
	updatedAt: timestamp(),
});

export const principals = Table.make("principal", {
	id: identifier().pipe(Column.primaryKey),
	kind: Column.text(),
	userId: identifier().pipe(Column.nullable),
	oidcSubject: Column.text().pipe(Column.nullable),
	createdAt: timestamp(),
	updatedAt: timestamp(),
});

export const principalTiers = Table.make("principalTier", {
	principalId: identifier(),
	tierId: identifier(),
	source: Column.text(),
	createdAt: timestamp(),
});

export const schemaTables = {
	user: users,
	session: sessions,
	account: accounts,
	verification: verifications,
	tier: tiers,
	principal: principals,
	principalTier: principalTiers,
};
