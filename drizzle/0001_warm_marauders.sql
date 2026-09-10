CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`deck_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`base_revision` integer NOT NULL,
	`status` text NOT NULL,
	`input` text NOT NULL,
	`model` text NOT NULL,
	`provider_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deadline_at` integer NOT NULL,
	`started_at` text,
	`proposal_id` text,
	`error_code` text,
	`error_message` text,
	`total_tokens` integer,
	`transition_id` text NOT NULL,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_runs_actor_request` ON `agent_runs` (`actor_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_runs_deck_created` ON `agent_runs` (`deck_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_actor_created` ON `agent_runs` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_created` ON `agent_runs` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_runs_one_active_deck` ON `agent_runs` (`deck_id`) WHERE "agent_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE TABLE `command_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`action` text NOT NULL,
	`deck_id` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_receipts_actor_request` ON `command_receipts` (`actor_id`,`request_id`);