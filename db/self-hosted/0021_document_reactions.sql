-- Likes are document-visible aggregate data; bookmarks remain actor-private.
CREATE TABLE lanka.document_reactions (
 tenant_id uuid NOT NULL,material_id uuid NOT NULL,principal_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('like','bookmark')),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,material_id,principal_id,kind),
 FOREIGN KEY(tenant_id,material_id) REFERENCES lanka.materials(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,principal_id) REFERENCES lanka.principals(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX document_bookmarks_actor ON lanka.document_reactions(tenant_id,principal_id,kind,material_id);
CREATE TABLE lanka.document_reaction_receipts (
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,material_id uuid NOT NULL,
 fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,principal_id,request_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES lanka.principals(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,material_id) REFERENCES lanka.materials(tenant_id,id) ON DELETE CASCADE
);
