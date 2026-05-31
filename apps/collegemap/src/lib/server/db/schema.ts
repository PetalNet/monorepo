import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	firstName: text('first_name').notNull(),
	lastName: text('last_name').notNull(),
	passwordHash: text('password_hash').notNull(),
	collegeId: text('college_id').references(() => colleges.id),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const colleges = sqliteTable('colleges', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text('name').notNull(),
	latitude: real('latitude').notNull(),
	longitude: real('longitude').notNull(),
	isCustom: integer('is_custom', { mode: 'boolean' }).notNull().default(false)
});

export const settings = sqliteTable('settings', {
	id: integer('id').primaryKey().default(1),
	authMode: text('auth_mode', { enum: ['open', 'off'] }).notNull().default('open'),
	mapName: text('map_name').notNull().default('College Map')
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type College = typeof colleges.$inferSelect;
export type NewCollege = typeof colleges.$inferInsert;
export const collegeMetadata = sqliteTable('college_metadata', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	collegeName: text('college_name').notNull().unique(),
	description: text('description'),
	thumbnailUrl: text('thumbnail_url'),
	fetchedAt: integer('fetched_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export type Settings = typeof settings.$inferSelect;
