CREATE TABLE lanka.agent_bridge_executions (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,message_id uuid NOT NULL,id uuid NOT NULL,
 delegation_id uuid NOT NULL,status text NOT NULL CHECK(status IN ('claimed','running','stopped','failed')),
 lease_expires_at timestamptz NOT NULL,last_seen_at timestamptz NOT NULL DEFAULT now(),
 native_thread_id text,native_turn_id text,
 PRIMARY KEY(tenant_id,session_id,message_id),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,session_id,message_id) REFERENCES lanka.agent_bridge_messages(tenant_id,session_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,delegation_id) REFERENCES lanka.agent_delegations(tenant_id,id)
);
CREATE TABLE lanka.agent_bridge_execution_reports (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,request_id uuid NOT NULL,fingerprint text NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,execution_id,request_id),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES lanka.agent_bridge_executions(tenant_id,id) ON DELETE CASCADE
);
