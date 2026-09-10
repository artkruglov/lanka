-- Explicit private-session access for an existing, revocable workspace delegation.
CREATE TABLE lanka.agent_bindings (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,delegation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,session_id),
 FOREIGN KEY(tenant_id,session_id) REFERENCES lanka.agent_sessions(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,delegation_id) REFERENCES lanka.agent_delegations(tenant_id,id)
);
CREATE TABLE lanka.agent_bridge_messages (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,id uuid NOT NULL,sequence bigint NOT NULL,
 role text NOT NULL CHECK(role IN ('user','assistant')),text text NOT NULL CHECK(length(text) BETWEEN 1 AND 12000),
 origin text NOT NULL CHECK(origin IN ('lanka','mcp')),actor_id uuid NOT NULL,
 reply_to uuid, fingerprint text NOT NULL,
 delivery text NOT NULL CHECK(delivery IN ('waiting','received_by_mcp_client','completed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,session_id,id),UNIQUE(tenant_id,session_id,sequence),
 FOREIGN KEY(tenant_id,session_id) REFERENCES lanka.agent_sessions(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,session_id,reply_to) REFERENCES lanka.agent_bridge_messages(tenant_id,session_id,id),
 CHECK((role='user' AND origin='lanka' AND reply_to IS NULL) OR
       (role='assistant' AND origin='mcp' AND reply_to IS NOT NULL AND delivery='completed'))
);
CREATE UNIQUE INDEX bridge_one_answer ON lanka.agent_bridge_messages(tenant_id,session_id,reply_to) WHERE role='assistant';
