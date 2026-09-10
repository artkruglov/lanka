-- Explicit, short-lived document delegation. Plaintext credentials are never stored.
CREATE TABLE lanka.agent_delegations (
 tenant_id uuid NOT NULL REFERENCES lanka.tenants(id) ON DELETE CASCADE,
 id uuid NOT NULL, issuer_id uuid NOT NULL, material_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 capabilities text[] NOT NULL CHECK(capabilities IN (ARRAY['read']::text[],ARRAY['read','comment']::text[])),
 auth_epoch bigint NOT NULL, fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,issuer_id) REFERENCES lanka.principals(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,material_id) REFERENCES lanka.materials(tenant_id,id) ON DELETE CASCADE,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '1 hour')
);
CREATE INDEX agent_delegation_issuer ON lanka.agent_delegations(tenant_id,issuer_id,material_id);
