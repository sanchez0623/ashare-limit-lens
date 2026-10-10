CREATE TABLE `history_import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`requested_start` text NOT NULL,
	`requested_end` text NOT NULL,
	`name` text,
	`stage` text NOT NULL,
	`progress` text DEFAULT '{}' NOT NULL,
	`status_payload` text DEFAULT '{}' NOT NULL,
	`dataset_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
