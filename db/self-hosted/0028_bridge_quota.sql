-- A claim reserves one daily model attempt, including startup failures and cancellations.
-- Legacy execution rows conservatively reserve on migration day; do not infer start time from mutable last_seen_at.
ALTER TABLE lanka.agent_bridge_executions ADD COLUMN reserved_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX agent_bridge_execution_daily ON lanka.agent_bridge_executions(tenant_id,reserved_at,session_id);
