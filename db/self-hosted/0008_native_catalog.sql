ALTER TABLE lanka.workspace_catalogs ADD COLUMN origin text NOT NULL DEFAULT 'file-import';
ALTER TABLE lanka.workspace_catalogs ALTER COLUMN source_root DROP NOT NULL;
ALTER TABLE lanka.workspace_catalogs ALTER COLUMN migration_id DROP NOT NULL;
ALTER TABLE lanka.workspace_catalogs ALTER COLUMN source_hash DROP NOT NULL;
ALTER TABLE lanka.workspace_catalogs ALTER COLUMN report SET DEFAULT '{}';
ALTER TABLE lanka.workspace_catalogs ADD CONSTRAINT catalog_origin CHECK (
 (origin='file-import' AND source_root IS NOT NULL AND migration_id IS NOT NULL AND source_hash IS NOT NULL)
 OR (origin='native' AND source_root IS NULL AND migration_id IS NULL AND source_hash IS NULL)
);
