-- Retain renderer/font dependency bundles as immutable publication artifacts.
-- Existing publications remain readable without a bundle; no old bytes are rewritten.
ALTER TABLE lanka.publication_artifacts DROP CONSTRAINT publication_artifacts_kind_check;
ALTER TABLE lanka.publication_artifacts ADD CONSTRAINT publication_artifacts_kind_check
 CHECK(kind IN ('pdf','pptx','preview','dependencies'));
