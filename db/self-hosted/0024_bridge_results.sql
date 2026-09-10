-- References survive document removal so the journal can show an unavailable result.
-- Document/proposal existence and access are validated transactionally by the service.
CREATE TABLE lanka.agent_bridge_results (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,message_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 7),
 material_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),proposal_id uuid,
 PRIMARY KEY(tenant_id,session_id,message_id,position),
 FOREIGN KEY(tenant_id,session_id,message_id) REFERENCES lanka.agent_bridge_messages(tenant_id,session_id,id) ON DELETE CASCADE
);
