-- No backfill: the current installation cannot attest the package of an old revision.
CREATE TABLE lanka.revision_design_packages (
 tenant_id uuid NOT NULL, material_id uuid NOT NULL, revision integer NOT NULL,
 document_hash text NOT NULL, package_digest text NOT NULL,
 PRIMARY KEY(tenant_id,material_id,revision),
 FOREIGN KEY(tenant_id,material_id,revision,document_hash) REFERENCES lanka.material_revisions(tenant_id,material_id,revision,hash) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,package_digest) REFERENCES lanka.design_packages(tenant_id,digest)
);
CREATE TRIGGER revision_design_package_immutable BEFORE UPDATE ON lanka.revision_design_packages
 FOR EACH ROW EXECUTE FUNCTION lanka.reject_design_package_update();
