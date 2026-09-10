-- The first local, single-owner PostgreSQL slice. OIDC/RLS and shared sessions
-- are separate release gates; a loopback browser session is the only principal.
CREATE SCHEMA IF NOT EXISTS lanka;
CREATE TABLE IF NOT EXISTS lanka.materials (
  tenant_id uuid NOT NULL, id uuid NOT NULL, owner_id uuid NOT NULL,
  project jsonb NOT NULL, version bigint NOT NULL DEFAULT 1,
  folder_id uuid, trashed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE(tenant_id,id,owner_id)
);
CREATE INDEX IF NOT EXISTS materials_owner ON lanka.materials(tenant_id,owner_id,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS lanka.material_revisions (
  tenant_id uuid NOT NULL, material_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
  hash text NOT NULL CHECK(length(hash)=64), doc jsonb NOT NULL,
  action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,material_id,revision),
  FOREIGN KEY(tenant_id,material_id) REFERENCES lanka.materials(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS revisions_hash ON lanka.material_revisions(tenant_id,material_id,hash);
CREATE TABLE IF NOT EXISTS lanka.blobs (
  tenant_id uuid NOT NULL, material_id uuid NOT NULL, key text NOT NULL, bytes bytea NOT NULL,
  PRIMARY KEY(tenant_id,material_id,key),
  FOREIGN KEY(tenant_id,material_id) REFERENCES lanka.materials(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS lanka.command_receipts (
  tenant_id uuid NOT NULL, owner_id uuid NOT NULL, request_id uuid NOT NULL,
  material_id uuid NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,owner_id,request_id),
  FOREIGN KEY(tenant_id,material_id,owner_id) REFERENCES lanka.materials(tenant_id,id,owner_id)
);
CREATE TABLE IF NOT EXISTS lanka.agent_connections (
  tenant_id uuid NOT NULL, owner_id uuid NOT NULL, id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false, config_version integer NOT NULL DEFAULT 1,
  PRIMARY KEY(tenant_id,owner_id,id)
);
CREATE TABLE IF NOT EXISTS lanka.agent_sessions (
  tenant_id uuid NOT NULL, id uuid NOT NULL, material_id uuid NOT NULL, owner_id uuid NOT NULL,
  connection_id text NOT NULL DEFAULT 'local-codex', context_epoch integer NOT NULL DEFAULT 1,
  next_message_seq bigint NOT NULL DEFAULT 0, next_event_seq bigint NOT NULL DEFAULT 0,
  native_thread_id text, native_context_epoch integer, model text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,material_id,owner_id),
  UNIQUE(tenant_id,id,material_id),
  FOREIGN KEY(tenant_id,material_id,owner_id) REFERENCES lanka.materials(tenant_id,id,owner_id),
  FOREIGN KEY(tenant_id,owner_id,connection_id) REFERENCES lanka.agent_connections(tenant_id,owner_id,id)
);
CREATE TABLE IF NOT EXISTS lanka.agent_messages (
  tenant_id uuid NOT NULL, id uuid NOT NULL, session_id uuid NOT NULL, sequence bigint NOT NULL,
  role text NOT NULL CHECK(role IN ('user','assistant')), text text NOT NULL,
  status text NOT NULL CHECK(status IN ('complete','streaming','interrupted','failed')),
  mode text NOT NULL CHECK(mode IN ('discuss','edit')), selection jsonb NOT NULL,
  proposal_id text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,session_id,sequence), UNIQUE(tenant_id,id,session_id),
  FOREIGN KEY(tenant_id,session_id) REFERENCES lanka.agent_sessions(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS lanka.jobs (
  tenant_id uuid NOT NULL, id uuid NOT NULL, session_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','unknown')),
  fence integer NOT NULL DEFAULT 0, lease_until timestamptz, deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,session_id),
  FOREIGN KEY(tenant_id,session_id) REFERENCES lanka.agent_sessions(tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active ON lanka.jobs(tenant_id,session_id) WHERE status IN ('running','unknown');
CREATE TABLE IF NOT EXISTS lanka.agent_runs (
  tenant_id uuid NOT NULL, id uuid NOT NULL, session_id uuid NOT NULL, material_id uuid NOT NULL,
  user_message_id uuid NOT NULL, assistant_message_id uuid NOT NULL,
  base_revision integer NOT NULL, input_manifest jsonb NOT NULL, input_hash text NOT NULL,
  context_epoch integer NOT NULL, native_turn_id text,
  interrupt_acknowledged boolean NOT NULL DEFAULT false, error_code text,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,id,session_id) REFERENCES lanka.jobs(tenant_id,id,session_id),
  FOREIGN KEY(tenant_id,session_id,material_id) REFERENCES lanka.agent_sessions(tenant_id,id,material_id),
  FOREIGN KEY(tenant_id,user_message_id,session_id) REFERENCES lanka.agent_messages(tenant_id,id,session_id),
  FOREIGN KEY(tenant_id,assistant_message_id,session_id) REFERENCES lanka.agent_messages(tenant_id,id,session_id)
);
CREATE TABLE IF NOT EXISTS lanka.agent_events (
  tenant_id uuid NOT NULL, session_id uuid NOT NULL, sequence bigint NOT NULL,
  run_id uuid, kind text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,session_id,sequence),
  FOREIGN KEY(tenant_id,session_id) REFERENCES lanka.agent_sessions(tenant_id,id),
  FOREIGN KEY(tenant_id,run_id) REFERENCES lanka.agent_runs(tenant_id,id)
);
