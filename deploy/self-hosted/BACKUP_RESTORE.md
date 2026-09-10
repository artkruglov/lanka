# Database backup and restore (preview)

The verified scenario restores a two-slide Focus 3 document, its owner/organization, an uploaded PNG, a linked conversation with cancelled/waiting messages and both persisted PDF/PPTX artifacts into fresh PostgreSQL and runtime volumes. The recovered document is identical and artifact SHA-256 values match. Two identities with the same verified email retain separate organization access after restore; cross-organization library/document/image/conversation reads are denied. The PNG matches byte for byte; the conversation matches and message retry/cancellation still work. This does not yet certify other attachment types, agent replies or in-flight executions, or a production disaster-recovery drill.

## Back up

Run from the installation checkout. Finish or explicitly cancel active agent work before maintenance, then stop the application. Keep the pinned image/build and protected installation configuration with the backup. The database dump contains corporate data and identities; store it in your company's protected backup storage.

```sh
umask 077
lanka_backup_dir="$HOME/lanka-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$lanka_backup_dir"
docker compose -f deploy/self-hosted/compose.yaml stop app
docker compose -f deploy/self-hosted/compose.yaml exec -T db \
  pg_dump -U lanka_operator -d lanka -Fc --no-owner --no-acl \
  > "$lanka_backup_dir/database.dump.partial"
```

Only after `pg_dump` exits successfully, rename the completed dump and copy the protected configuration:

```sh
mv "$lanka_backup_dir/database.dump.partial" "$lanka_backup_dir/database.dump"
cp -R deploy/self-hosted/private "$lanka_backup_dir/private"
docker image inspect lanka-self-hosted:local --format '{{.Id}}' > "$lanka_backup_dir/image-id.txt"
git rev-parse HEAD > "$lanka_backup_dir/commit.txt"
docker compose -f deploy/self-hosted/compose.yaml up -d app
```

An image ID records what ran but does not save the image. Keep the matching image in an internal registry or archive it with `docker save` according to your deployment policy. This database procedure is not a backup of arbitrary external files or external agent profiles. Preserve any deployment-specific volumes/configuration in addition to the database.

## Restore into a separate installation

Use a separate checkout of the recorded application revision and its matching image. Keep the original deployment and volumes until the restore is accepted. Copy the protected `private` directory into that checkout, keeping its permissions; do not run the configuration generator over it. Use a different Compose project name and ensure the application port is free or explicitly overridden.

Start only the new database. Do not run migrations first: the dump already contains the matching schema.

```sh
docker compose -p lanka-restore -f deploy/self-hosted/compose.yaml up -d db
```

Wait until the database is healthy, then restore into the newly initialized, empty `lanka` database:

```sh
docker compose -p lanka-restore -f deploy/self-hosted/compose.yaml exec -T db \
  pg_restore -U lanka_operator -d lanka --no-owner --no-acl --exit-on-error \
  < "$lanka_backup_dir/database.dump"
docker compose -p lanka-restore -f deploy/self-hosted/compose.yaml --profile operator run --rm grant-runtime
docker compose -p lanka-restore -f deploy/self-hosted/compose.yaml up -d app
```

Run each command only after the previous one succeeds. Restore does not overwrite an existing installation in place. Operator identity comes from database initialization; the restricted application role is recreated by `grant-runtime`. Startup verifies migration checksums before serving requests.

Before switching traffic, verify corporate sign-in, membership/access boundaries, document versions, attached sources and saved exports. Compare saved artifact hashes against the backup's acceptance record. Resolve agent execution recovery explicitly before resuming work; this procedure does not establish that replaying an interrupted agent action is safe.

## Reproduce the current evidence

`node scripts/check-self-hosted-compose.mjs` uses a uniquely named disposable installation, completes the test login and exports, makes a custom-format dump, removes only its labelled QA volumes, restores the dump, reapplies runtime grants and verifies the document, attachment, conversation and both export hashes over authenticated HTTP. It cleans up its test containers, volumes, certificates and dump on completion. It does not remove or restore the operator's actual deployment.
