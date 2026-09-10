# Standalone Lanka installation (preview)

This Compose package runs the existing corporate server and PostgreSQL 16. It is separate from the local demo on port 4317 and from the hosted application. Corporate OIDC, HTTPS termination and agents are supplied by the operator. No built-in model or automatic organization provisioning is enabled.

Status: image build and isolated PostgreSQL runtime-role checks passed on linux/arm64; Compose startup, a full test OIDC session, organization provisioning, Focus 3 creation and PDF/PPTX exports also passed against a local test IdP; full installation remains under verification. A successful independent installation and real corporate OIDC/agent acceptance have not yet been recorded. Do not treat this as a production release.

## Interface preview and rollback

The refreshed interface is opt-in for corporate installations. After building the current image, enable it for the app service:

```sh
LANKA_UI_REFRESH=1 docker compose -f deploy/self-hosted/compose.yaml up -d app
```

Keep `LANKA_UI_REFRESH=1` in your deployment environment for subsequent Compose runs. To return to the classic interface, run the same command with `LANKA_UI_REFRESH=0`. Recreating the app container briefly interrupts requests; wait for active agent work to finish before changing it. This flag changes interface presentation and navigation, not stored decks, sources, access rules or exports. It does not declare user acceptance or production readiness.

## Prepare

Requirements: Docker with Compose v2, Node.js 22 for local configuration generation, a corporate OIDC client and an HTTPS reverse proxy. Run from the repository root:

```sh
node deploy/self-hosted/configure.mjs "$PWD/deploy/self-hosted/private"
```

The command requires a new directory and refuses to overwrite it. It generates separate operator and application passwords. The parent directory is mode 0700; individual bind-mounted secret files are readable by container UID 1000. Keep the directory private and excluded from source control and shared archives. Compose secrets here are local files, not an encrypted secret manager.

Edit `private/lanka.json` inside this deployment directory:

- `auth.origin`: the public HTTPS origin of Lanka, without a path.
- `auth.issuer`: the corporate OIDC issuer URL.
- `auth.clientId` and `auth.clientSecret`: the registered client credentials.
- Register `<auth.origin>/auth/callback` as the client's redirect URI.

Do not use the generated `.invalid` placeholders. The containers must be able to reach the issuer with valid TLS certificates. Configure your reverse proxy to forward the public origin to `127.0.0.1:4318`, including the original Host header. PostgreSQL has no published host port. A reverse proxy in another container needs an explicit network/upstream configuration; its own localhost is not the host.

## Install schema and start

```sh
docker compose -f deploy/self-hosted/compose.yaml build
docker compose -f deploy/self-hosted/compose.yaml up -d db
docker compose -f deploy/self-hosted/compose.yaml --profile operator run --rm migrate
docker compose -f deploy/self-hosted/compose.yaml --profile operator run --rm grant-runtime
docker compose -f deploy/self-hosted/compose.yaml up -d app
```

Run each command only after the previous command succeeds. `grant-runtime` creates the restricted `lanka_app` role and makes the migration registry read-only for it. Migration/provisioning jobs use separate operator credentials. Server startup verifies every migration checksum and refuses an incomplete schema; it does not migrate automatically.

## Create the first organization

Sign in through the public HTTPS URL first. An authenticated identity alone has no organization access. Identify the intended owner using the operator connection:

```sh
docker compose -f deploy/self-hosted/compose.yaml exec db psql -U lanka_operator -d lanka -c 'SELECT id, display_name, verified_email FROM lanka.auth_identities;'
```

Set `ownerUserId` to that identity UUID in `private/organization.json`, and choose the organization slug/name. Keep its generated `requestId` for an idempotent retry. Then:

```sh
docker compose -f deploy/self-hosted/compose.yaml --profile operator run --rm provision
```

Reload Lanka and verify the owner's access. Organization membership is explicit; matching an email domain grants no access. Connect a corporate agent using the application's scoped MCP/companion flow. This package does not mirror an arbitrary existing Codex chat or reuse its authentication automatically.

## Operate and verify

```sh
docker compose -f deploy/self-hosted/compose.yaml ps
docker compose -f deploy/self-hosted/compose.yaml logs --tail 100 app
docker compose -f deploy/self-hosted/compose.yaml stop
```

Compose reports application health using a local HTTP check and `SELECT 1` with the application's database credentials. It runs every 30 seconds, has a 5-second timeout and marks the container unhealthy after three failures (with a 20-second startup period). The check does not log credentials, create a browser session or call a model. It tests HTTP/database availability, not the availability of the external IdP or agent. Docker health status alone does not restart the container or send an alert; connect it to your operational monitoring.

The application has a 45-second graceful-stop window. It stops accepting new connections and lets existing HTTP requests finish before closing PostgreSQL connections. Finish or explicitly cancel active agent jobs before maintenance; the stop window does not guarantee completion of arbitrarily long work.

The `database` named volume holds the PostgreSQL data, including persisted documents/materials; `runtime` holds runtime working files. Stopping services preserves both. Never use `down -v` on a deployment whose data you need. Back up the database and protected configuration before an upgrade; see [database backup and restore](BACKUP_RESTORE.md) for the verified document/export scenario; full-stack recovery remains a release requirement. Do not rotate only the generated password file after the database exists: PostgreSQL initialization secrets do not change an existing role's password.

For upgrades, stop the application, take a backup, build the new image, run migrations and runtime grants with the same operator identity, then start and verify the application. Do not assume a database downgrade is supported.

Acceptance still required: a clean installation by another operator, real OIDC sign-in, organization isolation, creation/edit/review through a real agent, PDF/PPTX export, and backup restoration. The ordinary local demo remains available independently at its existing port.

## Reproduce technical checks

After building the image and server bundles, run from the repository root:

```sh
node scripts/check-self-hosted-runtime.mjs
node scripts/check-self-hosted-compose.mjs
```

These checks create uniquely named temporary Docker resources and remove only those resources on completion. The Compose check uses a temporary test IdP certificate with explicit CA trust, verifies a test PKCE login, explicit organization provisioning, editor assets and presentation exports. It does not complete a real corporate login or exercise a real agent. It requires the local `openssl` command. Results are written under `out/`.
