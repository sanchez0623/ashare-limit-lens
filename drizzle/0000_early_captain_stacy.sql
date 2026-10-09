CREATE TABLE `reviews` (
	`trade_date` text PRIMARY KEY NOT NULL,
	`snapshot_date` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	`ai_payload` text
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`trade_date` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL
);
