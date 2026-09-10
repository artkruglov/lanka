ALTER TABLE lanka.agent_messages DROP CONSTRAINT agent_messages_mode_check;
ALTER TABLE lanka.agent_messages ADD CONSTRAINT agent_messages_mode_check CHECK(mode IN ('discuss','edit','create'));
