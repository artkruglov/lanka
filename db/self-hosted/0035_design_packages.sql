-- Immutable package bytes; authorisation and release decisions are separate concerns.
CREATE TABLE lanka.design_packages (
 tenant_id uuid NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 manifest jsonb NOT NULL CHECK(octet_length(manifest::text)<=2097152),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,digest),
 CHECK(manifest->>'digest' IS NOT DISTINCT FROM digest)
);
CREATE TABLE lanka.design_package_assets (
 tenant_id uuid NOT NULL, package_digest text NOT NULL, path text NOT NULL,
 bytes bytea NOT NULL CHECK(octet_length(bytes)>0 AND octet_length(bytes)<=67108864),
 PRIMARY KEY(tenant_id,package_digest,path),
 FOREIGN KEY(tenant_id,package_digest) REFERENCES lanka.design_packages(tenant_id,digest) ON DELETE CASCADE
);
CREATE FUNCTION lanka.reject_design_package_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Design packages are immutable'; END;
$$;
CREATE TRIGGER design_package_immutable BEFORE UPDATE ON lanka.design_packages
 FOR EACH ROW EXECUTE FUNCTION lanka.reject_design_package_update();
CREATE TRIGGER design_package_asset_immutable BEFORE UPDATE ON lanka.design_package_assets
 FOR EACH ROW EXECUTE FUNCTION lanka.reject_design_package_update();
