ALTER TABLE lanka.material_revisions ADD COLUMN source_hash text;
CREATE INDEX material_revision_source_hash ON lanka.material_revisions(tenant_id,material_id,source_hash) WHERE source_hash IS NOT NULL;
