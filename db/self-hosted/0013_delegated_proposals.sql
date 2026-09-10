-- Existing keys retain their exact capabilities; proposal access requires a new explicit grant.
ALTER TABLE lanka.agent_delegations DROP CONSTRAINT agent_delegations_capabilities_check;
ALTER TABLE lanka.agent_delegations ADD CONSTRAINT agent_delegations_capabilities_check
 CHECK(capabilities IN (ARRAY['read']::text[],ARRAY['read','comment']::text[],ARRAY['read','comment','propose']::text[]));
