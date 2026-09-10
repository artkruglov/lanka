CREATE TABLE lanka.source_intakes (
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  id uuid NOT NULL,
  fingerprint text NOT NULL,
  name text NOT NULL,
  content_type text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 5000000),
  extraction jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  PRIMARY KEY (tenant_id,owner_id,id)
);
CREATE INDEX source_intakes_expiry ON lanka.source_intakes(expires_at);
