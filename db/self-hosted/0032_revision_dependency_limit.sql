-- 0031 was applied locally with a 1.5 MB limit before its committed 3 MB variant.
-- Preserve both original migration receipts; converge the constraint explicitly.
ALTER TABLE lanka.revision_dependency_snapshots
 DROP CONSTRAINT revision_dependency_snapshots_bytes_check,
 ADD CONSTRAINT revision_dependency_snapshots_bytes_check CHECK(octet_length(bytes) BETWEEN 1 AND 3000000);
