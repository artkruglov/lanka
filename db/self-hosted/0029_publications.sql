-- Activation inserts the frozen record and all dependencies in one transaction.
-- Preparation/rendering is external to this table. Withdrawal never edits the snapshot.
ALTER TABLE lanka.resource_nodes ADD CONSTRAINT resource_material_identity UNIQUE(tenant_id,id,material_id);
ALTER TABLE lanka.material_revisions ADD CONSTRAINT revision_document_identity UNIQUE(tenant_id,material_id,revision,hash);
CREATE TABLE lanka.publications (
 tenant_id uuid NOT NULL, id uuid NOT NULL, resource_id uuid NOT NULL, material_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0), document_hash text NOT NULL CHECK(document_hash ~ '^[a-f0-9]{64}$'),
 actor_id uuid NOT NULL, created_at timestamptz NOT NULL,
 payload jsonb NOT NULL, payload_bytes bytea NOT NULL, payload_hash text NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,resource_id,material_id) REFERENCES lanka.resource_nodes(tenant_id,id,material_id),
 FOREIGN KEY(tenant_id,material_id,source_revision,document_hash) REFERENCES lanka.material_revisions(tenant_id,material_id,revision,hash),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES lanka.principals(tenant_id,id),
 CHECK(octet_length(payload_bytes) BETWEEN 1 AND 1500000),
 CHECK(payload_hash=encode(sha256(payload_bytes),'hex')),
 CHECK(payload=convert_from(payload_bytes,'UTF8')::jsonb),
 CHECK(payload->>'format' IS NOT DISTINCT FROM 'lanka-publication/v1'),
 CHECK(payload->>'id' IS NOT DISTINCT FROM id::text),
 CHECK(payload#>>'{origin,tenantId}' IS NOT DISTINCT FROM tenant_id::text),
 CHECK(payload#>>'{origin,materialId}' IS NOT DISTINCT FROM material_id::text),
 CHECK(payload#>>'{origin,revision}' IS NOT DISTINCT FROM source_revision::text),
 CHECK(payload#>>'{origin,documentHash}' IS NOT DISTINCT FROM document_hash)
);
CREATE INDEX publications_catalog ON lanka.publications(tenant_id,created_at DESC,id DESC);
CREATE INDEX publications_document ON lanka.publications(tenant_id,material_id,source_revision DESC);
-- Private source blobs can subsequently change or be removed without rewriting a publication.
CREATE TABLE lanka.publication_blobs (
 tenant_id uuid NOT NULL, publication_id uuid NOT NULL, hash text NOT NULL,
 content_type text NOT NULL CHECK(content_type IN ('application/json','image/png','image/jpeg')),
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 5000000),
 PRIMARY KEY(tenant_id,publication_id,hash),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES lanka.publications(tenant_id,id),
 CHECK(hash=encode(sha256(bytes),'hex'))
);
CREATE TABLE lanka.publication_artifacts (
 tenant_id uuid NOT NULL, publication_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('pdf','pptx','preview')),
 page integer NOT NULL DEFAULT 0 CHECK(page BETWEEN 0 AND 40),
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 40000000), hash text NOT NULL,
 PRIMARY KEY(tenant_id,publication_id,kind,page),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES lanka.publications(tenant_id,id),
 CHECK(hash=encode(sha256(bytes),'hex')),
 CHECK((kind='preview' AND page>0) OR (kind<>'preview' AND page=0))
);
CREATE TABLE lanka.publication_withdrawals (
 tenant_id uuid NOT NULL, publication_id uuid NOT NULL, actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,publication_id),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES lanka.publications(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES lanka.principals(tenant_id,id)
);
CREATE TABLE lanka.publication_receipts (
 tenant_id uuid NOT NULL, actor_id uuid NOT NULL, request_id uuid NOT NULL, publication_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 operation text NOT NULL CHECK(operation IN ('publish','withdraw')),
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,actor_id,request_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES lanka.principals(tenant_id,id),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES lanka.publications(tenant_id,id)
);
CREATE TABLE lanka.publication_audit (
 tenant_id uuid NOT NULL, publication_id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('publish','withdraw')), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,publication_id,action),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES lanka.publications(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES lanka.principals(tenant_id,id)
);
-- Defense in depth even where existing default privileges grant UPDATE/DELETE.
-- Retention/purge requires an explicit operator migration, not a runtime delete.
CREATE FUNCTION lanka.reject_publication_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Publication records are immutable' USING ERRCODE='55000'; END;
$$;
CREATE TRIGGER immutable_publications BEFORE UPDATE OR DELETE ON lanka.publications FOR EACH ROW EXECUTE FUNCTION lanka.reject_publication_mutation();
CREATE TRIGGER immutable_publication_blobs BEFORE UPDATE OR DELETE ON lanka.publication_blobs FOR EACH ROW EXECUTE FUNCTION lanka.reject_publication_mutation();
CREATE TRIGGER immutable_publication_artifacts BEFORE UPDATE OR DELETE ON lanka.publication_artifacts FOR EACH ROW EXECUTE FUNCTION lanka.reject_publication_mutation();
CREATE TRIGGER immutable_publication_withdrawals BEFORE UPDATE OR DELETE ON lanka.publication_withdrawals FOR EACH ROW EXECUTE FUNCTION lanka.reject_publication_mutation();
CREATE TRIGGER immutable_publication_receipts BEFORE UPDATE OR DELETE ON lanka.publication_receipts FOR EACH ROW EXECUTE FUNCTION lanka.reject_publication_mutation();
CREATE TRIGGER immutable_publication_audit BEFORE UPDATE OR DELETE ON lanka.publication_audit FOR EACH ROW EXECUTE FUNCTION lanka.reject_publication_mutation();
