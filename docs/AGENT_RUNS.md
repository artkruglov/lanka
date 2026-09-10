# Agent execution protocol — v0.2

The pilot supports file exchange with external agents and an optional embedded Chat Completions provider. Both create proposals for human review. A successful run does not accept, approve or release its changes.

## Idempotent document commands

Browser document commands and MCP writes use a UUID `requestId`, scoped to the authenticated actor. Keep the same ID and payload when retrying the same intent; use a new ID for a new intent. A SHA-256 fingerprint covers the command surface and canonical payload, including the original expected revision. Reusing an ID with a different payload returns 409.

The command receipt, document update, revisions and audit commit in one D1 batch. A replay returns the original receipt revision and the currently accessible deck, without repeating the mutation. It rechecks current access; revoking access also denies receipt replay. Receipts are currently retained indefinitely. Browser legacy commands without a key are still accepted for compatibility; they do not receive replay protection. MCP writes require a key.

The browser automatically retries a network failure once with the same serialized request. It does not automatically retry HTTP failures, uploads or provider execution. If both attempts lose their responses, reload before issuing a new intent. File packet v2 includes an ID to preserve; legacy imports derive one from the proposal content.

## Run lifecycle

`POST /api/agent` accepts these same-origin, authenticated JSON operations:

| Action | Input | Effect |
|---|---|---|
| `start` | `requestId`, `deckId`, `expectedRevision`, `instruction`, `slideIds` | Saves a bounded snapshot and reserves an attempt; returns a queued run |
| `execute` | `runId` | Its author claims the queued run atomically and performs one provider request |
| `cancel` | `runId` | Its author or deck owner cancels an active run |

`GET /api/agent?deckId=…` returns the latest 20 runs, the current user's UTC-day allowance and whether the provider is configured. The editor displays the latest five runs. Snapshot bytes, provider URL and credentials are not included in history responses.

Allowed transitions: `queued → running → succeeded/failed`; either active state can become `cancelled` or `expired`. A queued run expires after 15 minutes. Execution claims a 60-second deadline; the provider HTTP request has a 45-second timeout. Cleanup is performed on authorized reads and starts. It is not an autonomous scheduler.

Unique constraints prevent duplicate actor/request IDs and more than one active run for a deck. A duplicate execute returns the existing state without making another provider request. A terminal run never restarts. To try again after failure, the user creates a new task with a new ID and a fresh snapshot.

The snapshot contains the selected slides, their referenced source excerpts and unresolved comments. Changing the configured endpoint or model after start prevents execution of the stored snapshot against the new configuration. Credentials remain in server environment variables. Provider responses are bounded to 400 KB and validated against the slide schema and selected IDs.

## Cancellation and concurrency guarantees

The proposal update tests the run's actor, deck, running status and deadline inside the same D1 transaction as the document compare-and-swap and transition to `succeeded`. Cancellation that commits first prevents the proposal write, even if a worker already received or parsed the model response. If completion commits first, cancellation returns `succeeded`; it does not remove an existing proposal.

The original content revision is checked at completion. A concurrent human content edit causes a conflict; the model result cannot overwrite it. Concurrent aggregate changes can also cause a safe failure. Background history polling never replaces unsaved editor text or silently advances its base revision.

Cancellation does not promise provider-side abortion or zero billing. Available token usage can still be recorded after cancellation without reopening the task. A Worker crash or browser disconnect may leave a running task until expiration. There is no automatic redispatch, recovery queue or exactly-once external billing guarantee in this version.

## Attempt limits

| Limit | Default | Configuration |
|---|---|---|
| Per authenticated user per UTC day | 20 attempts | `AGENT_DAILY_RUN_LIMIT`, clamped to 1–100 |
| Entire Site per UTC day | 100 attempts | `AGENT_SITE_DAILY_RUN_LIMIT`, clamped to 1–1000 |
| Selected slides | 1–8 | Fixed |
| Serialized snapshot | 64,000 characters | Fixed |
| Requested output tokens | 7,000 | Fixed |

Reservation is part of the conditional SQL insert and remains atomic across competing requests, decks and principals. Cancelled, failed, expired and never-executed queued runs consume the reserved attempt. Validation failures do not. The limits cover embedded provider requests; external file/MCP agents use their own provider accounting. This is not a monetary budget or a tokenizer-accurate input token cap.

## Remaining enterprise gates

Delegated authentication/scopes and separate approval identities; durable queue, recovery and provider idempotency/reconciliation; project cost accounting; retention and audit exports; live provider and Codex/Qwen acceptance; browser end-to-end checks and production load testing. Test providers in this repository are injected responses, not evidence of a live model connection.
