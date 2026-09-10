CREATE TABLE lanka.tenants (
 id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
 authz_epoch bigint NOT NULL DEFAULT 1 CHECK(authz_epoch>0),
 created_by uuid NOT NULL REFERENCES lanka.auth_identities(id),
 provision_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(length(name) BETWEEN 1 AND 180)
);
CREATE TABLE lanka.principals (
 tenant_id uuid NOT NULL REFERENCES lanka.tenants(id), id uuid NOT NULL,
 kind text NOT NULL CHECK(kind='human'), user_id uuid NOT NULL REFERENCES lanka.auth_identities(id),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,user_id)
);
CREATE TABLE lanka.organization_memberships (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','admin','member')),
 status text NOT NULL CHECK(status IN ('active','suspended')),
 joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES lanka.principals(tenant_id,id)
);
CREATE INDEX principals_user ON lanka.principals(user_id,tenant_id);
CREATE TABLE lanka.organization_receipts (
 tenant_id uuid NOT NULL, actor_id uuid NOT NULL, request_id uuid NOT NULL,
 fingerprint text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,request_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES lanka.principals(tenant_id,id)
);
CREATE TABLE lanka.organization_audit (
 tenant_id uuid NOT NULL REFERENCES lanka.tenants(id), sequence bigint NOT NULL,
 actor_id uuid, action text NOT NULL, target_id uuid, metadata jsonb NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,sequence),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES lanka.principals(tenant_id,id),
 FOREIGN KEY(tenant_id,target_id) REFERENCES lanka.principals(tenant_id,id)
);
