ALTER TABLE lanka.agent_delegations ADD COLUMN requires_task boolean NOT NULL DEFAULT false;
ALTER TABLE lanka.agent_bridge_messages ADD COLUMN task jsonb;
