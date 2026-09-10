-- Version-bound requests do not grant access or contain private conversation data.
CREATE TABLE lanka.colleague_reviews (
 tenant_id uuid NOT NULL, id uuid NOT NULL, material_id uuid NOT NULL,
 revision integer NOT NULL, document_hash text NOT NULL,
 sender_id uuid NOT NULL, recipient_id uuid NOT NULL, state jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,material_id,revision,document_hash) REFERENCES lanka.material_revisions(tenant_id,material_id,revision,hash) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,sender_id) REFERENCES lanka.principals(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,recipient_id) REFERENCES lanka.principals(tenant_id,id) ON DELETE CASCADE,
 CHECK(sender_id<>recipient_id), CHECK(octet_length(state::text)<=12000),
 CHECK(state->>'id' IS NOT DISTINCT FROM id::text),
 CHECK(state->>'tenantId' IS NOT DISTINCT FROM tenant_id::text),
 CHECK(state->>'documentId' IS NOT DISTINCT FROM material_id::text),
 CHECK(state->>'senderId' IS NOT DISTINCT FROM sender_id::text),
 CHECK(state->>'recipientId' IS NOT DISTINCT FROM recipient_id::text),
 CHECK(state->'target'->>'revision' IS NOT DISTINCT FROM revision::text),
 CHECK(state->'target'->>'documentHash' IS NOT DISTINCT FROM document_hash)
);
CREATE INDEX colleague_reviews_inbox ON lanka.colleague_reviews(tenant_id,recipient_id,id);
CREATE TABLE lanka.colleague_review_receipts (
 tenant_id uuid NOT NULL, actor_id uuid NOT NULL, request_id uuid NOT NULL,
 review_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,request_id),
 FOREIGN KEY(tenant_id,review_id) REFERENCES lanka.colleague_reviews(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES lanka.principals(tenant_id,id) ON DELETE CASCADE,
 CHECK(octet_length(result::text)<=12000)
);
