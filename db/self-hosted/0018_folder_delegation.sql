-- NULL preserves existing workspace scope. A removed anchor never widens a key.
ALTER TABLE lanka.agent_delegations ADD COLUMN folder_resource_id uuid;
ALTER TABLE lanka.agent_delegations ADD CONSTRAINT agent_delegations_folder_scope_check CHECK (folder_resource_id IS NULL OR scope_kind='workspace');
ALTER TABLE lanka.agent_delegations ADD CONSTRAINT agent_delegations_folder_scope_fk FOREIGN KEY(tenant_id,folder_resource_id) REFERENCES lanka.resource_nodes(tenant_id,id) ON DELETE CASCADE;
