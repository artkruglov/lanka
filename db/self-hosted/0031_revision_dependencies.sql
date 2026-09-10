-- New revisions capture their own source metadata and content-addressed bytes.
-- No backfill: current sources cannot prove the dependencies of old revisions.
CREATE TABLE lanka.revision_dependency_snapshots (
 tenant_id uuid NOT NULL, material_id uuid NOT NULL, revision integer NOT NULL,
 document_hash text NOT NULL, payload jsonb NOT NULL, bytes bytea NOT NULL, hash text NOT NULL,
 PRIMARY KEY(tenant_id,material_id,revision),
 FOREIGN KEY(tenant_id,material_id,revision,document_hash) REFERENCES lanka.material_revisions(tenant_id,material_id,revision,hash) ON DELETE CASCADE,
 CHECK(octet_length(bytes) BETWEEN 1 AND 3000000), CHECK(hash=encode(sha256(bytes),'hex')),
 CHECK(payload=convert_from(bytes,'UTF8')::jsonb),
 CHECK(payload->>'format' IS NOT DISTINCT FROM 'lanka-revision-dependencies/v1'),
 CHECK(payload->>'documentId' IS NOT DISTINCT FROM material_id::text),
 CHECK(payload->>'revision' IS NOT DISTINCT FROM revision::text),
 CHECK(payload->>'documentHash' IS NOT DISTINCT FROM document_hash)
);
CREATE TABLE lanka.revision_dependency_blobs (
 tenant_id uuid NOT NULL, material_id uuid NOT NULL, hash text NOT NULL, bytes bytea NOT NULL,
 PRIMARY KEY(tenant_id,material_id,hash),
 FOREIGN KEY(tenant_id,material_id) REFERENCES lanka.materials(tenant_id,id) ON DELETE CASCADE,
 CHECK(octet_length(bytes) BETWEEN 1 AND 5000000),CHECK(hash=encode(sha256(bytes),'hex'))
);
-- Parent deletion is an explicit document/history purge; runtime cannot edit or
-- directly delete retained dependency rows. No separate retention policy is invented.
CREATE TRIGGER revision_dependency_snapshots_immutable BEFORE UPDATE ON lanka.revision_dependency_snapshots
 FOR EACH ROW EXECUTE FUNCTION lanka.reject_publication_mutation();
CREATE TRIGGER revision_dependency_blobs_immutable BEFORE UPDATE ON lanka.revision_dependency_blobs
 FOR EACH ROW EXECUTE FUNCTION lanka.reject_publication_mutation();
