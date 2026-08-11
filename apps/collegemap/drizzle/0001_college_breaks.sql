CREATE TABLE IF NOT EXISTS `college_breaks` (
	`id` text PRIMARY KEY NOT NULL,
	`college_id` text NOT NULL,
	`label` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`kind` text NOT NULL,
	`derivation` text NOT NULL,
	`source_url` text,
	`quote` text,
	`academic_year` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`college_id`) REFERENCES `colleges`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `college_breaks_college_id_start_date_idx` ON `college_breaks` (`college_id`, `start_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `college_breaks_identity_unique` ON `college_breaks` (`college_id`, `label`, `start_date`, `academic_year`);
