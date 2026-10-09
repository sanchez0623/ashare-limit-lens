CREATE TABLE `paper_executor_health` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_live_sessions` (
	`trade_date` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_live_ticks` (
	`trade_date` text NOT NULL,
	`sequence` integer NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`trade_date`, `sequence`)
);
