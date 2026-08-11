import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { INSTITUTION_KINDS } from "../../institutions";

export const users = sqliteTable("users", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	firstName: text("first_name").notNull(),
	lastName: text("last_name").notNull(),
	passwordHash: text("password_hash").notNull(),
	collegeId: text("college_id").references(() => colleges.id),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/**
 * A place someone is affiliated with: a college, a base, a workplace, or something else.
 *
 * Still called `colleges`, and still the row every `college_id` points at. Generalising it meant
 * one new column rather than a second table and a second nullable foreign key, so every join, every
 * map pin and every who-is-free path kept working unchanged. The name is now a misnomer; renaming
 * the table is a separate, purely cosmetic migration.
 *
 * `latitude` and `longitude` stay NOT NULL for every kind. They are all places and this is a map;
 * the existing `isCustom` path already lets someone supply coordinates for somewhere that is not in
 * the pre-seeded list.
 */
export const colleges = sqliteTable("colleges", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	/**
	 * What sort of place this is, and so which calendar the app fills in for the people here.
	 *
	 * Defaults to `college` because that is what every row was before the column existed, and what
	 * the migration set them all to.
	 */
	kind: text("kind", { enum: INSTITUTION_KINDS }).notNull().default("college"),
	latitude: real("latitude").notNull(),
	longitude: real("longitude").notNull(),
	isCustom: integer("is_custom", { mode: "boolean" }).notNull().default(false),
});

export const settings = sqliteTable("settings", {
	id: integer("id").primaryKey().default(1),
	authMode: text("auth_mode", { enum: ["open", "off"] })
		.notNull()
		.default("open"),
	mapName: text("map_name").notNull().default("College Map"),
});

export type User = typeof users.$inferSelect;
export const collegeMetadata = sqliteTable("college_metadata", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	collegeName: text("college_name").notNull().unique(),
	description: text("description"),
	thumbnailUrl: text("thumbnail_url"),
	fetchedAt: integer("fetched_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/**
 * A break is a named, inclusive range of calendar days belonging to one person.
 *
 * The dates are TEXT in `YYYY-MM-DD`, not timestamps, on purpose. "Winter break starts Dec 19"
 * means Dec 19 wherever you are standing; storing an instant would let a timezone shift it by a
 * day. See `$lib/dates`.
 */
export const breaks = sqliteTable("breaks", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	userId: text("user_id")
		.notNull()
		.references(() => users.id),
	label: text("label").notNull(),
	startDate: text("start_date").notNull(),
	endDate: text("end_date").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/**
 * An institutional academic-calendar entry. Unlike `breaks`, these belong to a college rather than
 * to a person, so one cited calendar can serve every student at that college.
 */
export const collegeBreaks = sqliteTable(
	"college_breaks",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		collegeId: text("college_id")
			.notNull()
			.references(() => colleges.id),
		label: text("label").notNull(),
		startDate: text("start_date").notNull(),
		endDate: text("end_date").notNull(),
		kind: text("kind", {
			enum: ["break", "holiday", "term_boundary", "exam", "commencement", "admin", "unknown"],
		}).notNull(),
		derivation: text("derivation", { enum: ["quoted", "derived"] }).notNull(),
		sourceUrl: text("source_url"),
		quote: text("quote"),
		academicYear: text("academic_year").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("college_breaks_college_id_start_date_idx").on(table.collegeId, table.startDate),
		uniqueIndex("college_breaks_identity_unique").on(
			table.collegeId,
			table.label,
			table.startDate,
			table.academicYear,
		),
	],
);
