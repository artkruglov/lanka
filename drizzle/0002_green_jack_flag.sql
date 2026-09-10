CREATE TABLE `presentation_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`deck_id` text NOT NULL,
	`owner` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`version` integer NOT NULL,
	`mutation_id` text NOT NULL,
	`updated_at` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`run_deadline` integer,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_owner_request` ON `presentation_tasks` (`owner`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_deck` ON `presentation_tasks` (`deck_id`);--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `presentation_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_events_sequence` ON `task_events` (`task_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `task_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `presentation_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_receipts_actor_request` ON `task_receipts` (`actor_id`,`request_id`);