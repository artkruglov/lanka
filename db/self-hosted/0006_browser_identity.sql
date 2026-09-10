-- Authentication is independent of tenants and document permissions.
-- Neither email nor a supplied tenant header grants membership.
CREATE TABLE lanka.auth_identities (
 id uuid PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL,
 display_name text, verified_email text, disabled boolean NOT NULL DEFAULT false,
 auth_epoch bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(issuer,subject), CHECK(length(subject) BETWEEN 1 AND 255)
);
CREATE TABLE lanka.browser_logins (
 deployment text NOT NULL, state_hash text NOT NULL, browser_hash text NOT NULL,
 verifier text NOT NULL, nonce text NOT NULL, return_to text NOT NULL,
 expires_at timestamptz NOT NULL, PRIMARY KEY(deployment,state_hash)
);
CREATE INDEX browser_logins_expiry ON lanka.browser_logins(expires_at);
CREATE TABLE lanka.browser_sessions (
 token_hash text PRIMARY KEY, id uuid NOT NULL UNIQUE, deployment text NOT NULL,
 identity_id uuid NOT NULL REFERENCES lanka.auth_identities(id) ON DELETE CASCADE,
 auth_epoch bigint NOT NULL, expires_at timestamptz NOT NULL,
 idle_expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(length(token_hash)=64)
);
CREATE INDEX browser_sessions_identity ON lanka.browser_sessions(identity_id);
CREATE INDEX browser_sessions_expiry ON lanka.browser_sessions(expires_at);
