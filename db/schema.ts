import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
export const decks = sqliteTable(
  "decks",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull(),
    version: integer("version").notNull(),
    mutationId: text("mutation_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_decks_owner_updated").on(t.owner, t.updatedAt)],
);
export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id),
    email: text("email").notNull(),
    role: text("role").notNull(),
  },
  (t) => [
    uniqueIndex("idx_memberships_deck_email").on(t.deckId, t.email),
    index("idx_memberships_email").on(t.email),
  ],
);
export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id),
    revision: integer("revision").notNull(),
    doc: text("doc").notNull(),
    createdAt: text("created_at").notNull(),
    actor: text("actor").notNull(),
  },
  (t) => [uniqueIndex("idx_revisions_deck_revision").on(t.deckId, t.revision)],
);
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_events_deck_created").on(t.deckId, t.createdAt)],
);
export const releases = sqliteTable(
  "releases",
  {
    id: text("id").primaryKey(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    doc: text("doc").notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [uniqueIndex("idx_releases_deck_revision").on(t.deckId, t.revision)],
);
export const brands = sqliteTable(
  "brands",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    data: text("data").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_brands_owner").on(t.owner)],
);
export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id),
    owner: text("owner").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    sha256: text("sha256").notNull(),
    contentType: text("content_type").notNull(),
    excerpt: text("excerpt").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_assets_deck").on(t.deckId)],
);

export const commandReceipts = sqliteTable(
  "command_receipts",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    requestId: text("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    action: text("action").notNull(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_receipts_actor_request").on(t.actorId, t.requestId)],
);
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id),
    actorId: text("actor_id").notNull(),
    actorEmail: text("actor_email").notNull(),
    requestId: text("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    baseRevision: integer("base_revision").notNull(),
    status: text("status").notNull(),
    input: text("input").notNull(),
    model: text("model").notNull(),
    providerHash: text("provider_hash").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deadlineAt: integer("deadline_at").notNull(),
    startedAt: text("started_at"),
    proposalId: text("proposal_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    totalTokens: integer("total_tokens"),
    transitionId: text("transition_id").notNull(),
  },
  (t) => [
    uniqueIndex("idx_runs_actor_request").on(t.actorId, t.requestId),
    index("idx_runs_deck_created").on(t.deckId, t.createdAt),
    index("idx_runs_actor_created").on(t.actorId, t.createdAt),
    index("idx_runs_created").on(t.createdAt),
    uniqueIndex("idx_runs_one_active_deck")
      .on(t.deckId)
      .where(sql`${t.status} IN ('queued', 'running')`),
  ],
);

export const presentationTasks = sqliteTable(
  "presentation_tasks",
  {
    id: text("id").primaryKey(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id),
    owner: text("owner").notNull(),
    requestId: text("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    state: text("state").notNull(),
    version: integer("version").notNull(),
    mutationId: text("mutation_id").notNull(),
    updatedAt: text("updated_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    runDeadline: integer("run_deadline"),
  },
  (t) => [
    uniqueIndex("idx_tasks_owner_request").on(t.owner, t.requestId),
    uniqueIndex("idx_tasks_deck").on(t.deckId),
  ],
);
export const taskEvents = sqliteTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => presentationTasks.id),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_task_events_sequence").on(t.taskId, t.sequence)],
);
export const taskReceipts = sqliteTable(
  "task_receipts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => presentationTasks.id),
    actorId: text("actor_id").notNull(),
    requestId: text("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
  },
  (t) => [
    uniqueIndex("idx_task_receipts_actor_request").on(t.actorId, t.requestId),
  ],
);
