-- Keep deleted upload IDs retired so late parser completions/retries cannot resurrect files.
CREATE TABLE lanka.source_intake_deletions (
 tenant_id uuid NOT NULL,
 owner_id uuid NOT NULL,
 id uuid NOT NULL,
 sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 deleted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,owner_id,id)
);
