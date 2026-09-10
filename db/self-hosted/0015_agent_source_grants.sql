-- A human explicitly delegates immutable staged source snapshots to one workspace key.
CREATE TABLE lanka.agent_source_grants (
 tenant_id uuid NOT NULL,
 owner_id uuid NOT NULL,
 source_id uuid NOT NULL,
 delegation_id uuid NOT NULL,
 sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 accept_partial boolean NOT NULL DEFAULT false,
 PRIMARY KEY (tenant_id,delegation_id,source_id),
 FOREIGN KEY (tenant_id,owner_id,source_id) REFERENCES lanka.source_intakes(tenant_id,owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY (tenant_id,delegation_id) REFERENCES lanka.agent_delegations(tenant_id,id) ON DELETE CASCADE
);
