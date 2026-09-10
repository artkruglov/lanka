-- Existing create keys do not gain library-management authority.
ALTER TABLE lanka.agent_delegations DROP CONSTRAINT agent_delegations_scope_check;
ALTER TABLE lanka.agent_delegations ADD CONSTRAINT agent_delegations_scope_check CHECK (
 (scope_kind='document' AND material_id IS NOT NULL AND capabilities IN
  (ARRAY['read']::text[],ARRAY['read','comment']::text[],ARRAY['read','comment','propose']::text[])) OR
 (scope_kind='workspace' AND material_id IS NULL AND capabilities IN
  (ARRAY['read']::text[],ARRAY['read','comment','propose','create']::text[],ARRAY['read','comment','propose','create','organize']::text[]))
);
