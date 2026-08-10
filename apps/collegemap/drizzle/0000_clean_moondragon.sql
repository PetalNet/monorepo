CREATE TABLE IF NOT EXISTS `breaks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `college_metadata` (
	`id` text PRIMARY KEY NOT NULL,
	`college_name` text NOT NULL,
	`description` text,
	`thumbnail_url` text,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `college_metadata_college_name_unique` ON `college_metadata` (`college_name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `colleges` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`is_custom` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`auth_mode` text DEFAULT 'open' NOT NULL,
	`map_name` text DEFAULT 'College Map' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`college_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`college_id`) REFERENCES `colleges`(`id`) ON UPDATE no action ON DELETE no action
);
