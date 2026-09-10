-- Existing credentials remain document-scoped; workspace access requires a new human grant.
ALTER TABLE lanka.agent_delegations ADD COLUMN scope_kind text NOT NULL DEFAULT 'document';
ALTER TABLE lanka.agent_delegations ALTER COLUMN material_id DROP NOT NULL;
ALTER TABLE lanka.agent_delegations DROP CONSTRAINT agent_delegations_capabilities_check;
ALTER TABLE lanka.agent_delegations ADD CONSTRAINT agent_delegations_scope_check CHECK (
 (scope_kind='document' AND material_id IS NOT NULL AND capabilities IN
  (ARRAY['read']::text[],ARRAY['read','comment']::text[],ARRAY['read','comment','propose']::text[])) OR
 (scope_kind='workspace' AND material_id IS NULL AND capabilities IN
  (ARRAY['read']::text[],ARRAY['read','comment','propose','create']::text[]))
);
