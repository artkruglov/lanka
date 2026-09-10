CREATE TABLE lanka.workspace_catalogs (
 tenant_id uuid NOT NULL, owner_id uuid NOT NULL, source_root text NOT NULL,
 migration_id uuid NOT NULL, source_hash text NOT NULL, report jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,owner_id)
);
CREATE TABLE lanka.catalog_folders (
 tenant_id uuid NOT NULL, owner_id uuid NOT NULL, id uuid NOT NULL, name text NOT NULL,
 PRIMARY KEY(tenant_id,owner_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES lanka.workspace_catalogs(tenant_id,owner_id),
 CHECK(length(name) BETWEEN 1 AND 180)
);
CREATE TABLE lanka.material_aliases (
 tenant_id uuid NOT NULL, owner_id uuid NOT NULL, alias_id uuid NOT NULL, material_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,owner_id,alias_id),
 FOREIGN KEY(tenant_id,material_id,owner_id) REFERENCES lanka.materials(tenant_id,id,owner_id) ON DELETE CASCADE
);
CREATE TABLE lanka.catalog_receipts (
 tenant_id uuid NOT NULL, owner_id uuid NOT NULL, request_id uuid NOT NULL,
 fingerprint text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(tenant_id,owner_id,request_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES lanka.workspace_catalogs(tenant_id,owner_id)
);
CREATE TABLE lanka.imported_project_receipts (
 tenant_id uuid NOT NULL, owner_id uuid NOT NULL, material_id uuid NOT NULL, request_id uuid NOT NULL,
 source_hash text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(tenant_id,owner_id,request_id),
 FOREIGN KEY(tenant_id,material_id,owner_id) REFERENCES lanka.materials(tenant_id,id,owner_id) ON DELETE CASCADE
);
