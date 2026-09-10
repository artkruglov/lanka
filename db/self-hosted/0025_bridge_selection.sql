-- Addresses only; no hidden source text or private notes are copied into the mailbox.
CREATE TABLE lanka.agent_bridge_selections (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,message_id uuid NOT NULL,
 material_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 slide_id text NOT NULL,element_id text,field text CHECK(field IN ('title','body','takeaway')),
 PRIMARY KEY(tenant_id,session_id,message_id),
 CHECK(element_id IS NULL OR field IS NULL),
 FOREIGN KEY(tenant_id,session_id,message_id) REFERENCES lanka.agent_bridge_messages(tenant_id,session_id,id) ON DELETE CASCADE
);
