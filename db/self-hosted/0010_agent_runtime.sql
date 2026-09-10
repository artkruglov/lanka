-- Existing connections keep their configured profile until an explicit switch.
ALTER TABLE lanka.agent_connections ADD COLUMN runtime_mode text NOT NULL DEFAULT 'configured'
  CHECK (runtime_mode IN ('configured','dedicated'));
