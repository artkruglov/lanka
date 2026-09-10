CREATE TABLE lanka.export_artifacts (
 tenant_id uuid NOT NULL, material_id uuid NOT NULL, id uuid NOT NULL,
 created_at timestamptz NOT NULL, manifest jsonb NOT NULL, bytes bytea NOT NULL,
 PRIMARY KEY (tenant_id,material_id,id),
 FOREIGN KEY (tenant_id,material_id) REFERENCES lanka.materials(tenant_id,id) ON DELETE CASCADE,
 CHECK (octet_length(bytes) BETWEEN 1 AND 40000000),
 CHECK (manifest->>'format' = 'lanka-export/v1')
);
CREATE INDEX export_artifacts_history ON lanka.export_artifacts(tenant_id,material_id,created_at DESC,id DESC);
