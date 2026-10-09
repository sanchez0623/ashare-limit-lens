CREATE TABLE `paper_configuration_history` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_plan_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`signal_date` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL
);
