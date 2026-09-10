-- Permanent document source consent; deliberately independent of temporary intakes.
CREATE TABLE lanka.document_source_grants (
 tenant_id uuid NOT NULL,
 delegation_id uuid NOT NULL,
 material_id uuid NOT NULL,
 source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 180),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 accept_partial boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,delegation_id,source_id),
 FOREIGN KEY(tenant_id,delegation_id) REFERENCES lanka.agent_delegations(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,material_id) REFERENCES lanka.materials(tenant_id,id) ON DELETE CASCADE
);
