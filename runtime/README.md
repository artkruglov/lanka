# Codex worker

Lanka's background supervisor uses the actual `@openai/codex` **0.153.4** App Server over JSONL stdio. It does not substitute a Chat Completions request for Codex. The package and platform binary are pinned by `package-lock.json`. The protocol was inspected using `codex app-server generate-json-schema`; reference: [App Server documentation](https://learn.chatgpt.com/docs/app-server).

## What this worker does

1. Poll authorized tasks and atomically claim one queued task with a 90-second lease.
2. Download that task's saved source snapshot through the authenticated Lanka MCP gateway; verify SHA-256; extract bounded text locally.
3. Ask Codex for clarification questions or a story plan. Save the result and stop for human input/acceptance.
4. After plan acceptance, ask Codex for the complete deck using the pinned brand and slide identities.
5. Validate schema, references, accepted intentions and shared-scene layout on the server. Use a separate Codex thread to critique argumentation. Allow at most three composition attempts within the same phase.
6. Submit a candidate and critique for human acceptance. The worker cannot accept a plan, accept slides, approve or publish through task tools.

The supervisor owns tools and state writes. Codex receives bounded source data and emits JSON; shell, browser, apps, hooks and image tools are disabled. This is a deliberately narrow runtime integration. It does not yet expose a general agent toolbox, versioned presentation skills, persisted cloud-task thread resume, monetary budgets or Qwen support.

## Run

Requires Node >=22.13, Python 3 and `pdftotext` (Poppler). In this directory:

```sh
npm ci --omit=dev
cp .env.example .env
node --env-file=.env check.mjs
node --env-file=.env worker.mjs
```

Set secrets in the deployment environment or secret manager. Never commit them or send them in chat. `OPENAI_API_KEY` is supplied to the child using the documented `account/login/start` API-key flow. `LANKA_CODEX_MODEL` must name a model available to that account. No default model or credentials are invented. `check.mjs` checks protocol/account configuration without generating a presentation; successful configuration is not an inference acceptance test.

`LANKA_MCP_URL` must point to an **already configured, authorized authentication gateway**, returning the JSON-response MCP transport. `LANKA_ACCESS_TOKEN` authenticates that gateway. A generic bearer token and the private Site URL alone do not provide delegated Site authentication. For external Cloudflare hosting, 0.5 adds a limited task-only gateway with a separate configured worker identity; see [deploy/README.md](../deploy/README.md). It does not issue general OAuth/scoped credentials or authenticate the existing private Site. Do not copy a user's browser session or expose trusted user headers to the internet. Enterprise separation of agent identity from human approval remains a release gate.

For a container host, `docker compose up --build -d` uses the included service definition. It starts one non-root worker with memory/CPU/PID limits, a read-only root filesystem and temporary work storage; no inbound port. Docker execution was not available in the development environment, so the image and deployment remain unverified. The same image can be hosted wherever the configured gateway and approved inference endpoint are reachable; no external cloud resources have been provisioned by this change.

## Reliability and limits

- D1 is the authoritative queue/state store; the worker has no authoritative local database. Closing the UI does not drop a job.
- One active claim per deck, heartbeat every 20 seconds, 10-minute attempt deadline, maximum 10 claims per task. This is not a financial spending cap or a claim of production queue throughput.
- Cancellation, expiration and changed permissions fence subsequent writes. In-flight inference may still incur cost.
- Lost network responses retry once with identical command bytes. Atomic receipts prevent duplicate effects. HTTP errors are not retried blindly.
- A failed phase is retried by an explicit human action. Saved answers, extractions and the accepted plan survive; an ephemeral Codex thread is recreated. There is no exact thread continuation or automatic redispatch of expired attempts.
- At most 5 MB per uploaded Office/PDF source, 100k extracted characters per attempt, 80 fragments per source, PDF first 50 pages. Text uploads retain the existing 200 KB limit. No OCR, macro execution, external Office relationships, formula recalculation, style/template extraction or full PowerPoint import.
- Extraction reports have source hashes and locators. Their content is not independently verified by the API; semantic critique uses the same configured model in a separate thread and is not a factual guarantee.
- Temporary source files, Codex home and auth files are removed on normal completion. Container restarts discard temporary storage. Run only in an approved data environment.

## Checks

```sh
node --test app-server.test.mjs worker.test.mjs
python3 -m unittest extract_test.py test_extract.py
```

Protocol tests simulate JSONL events and approvals; worker tests inject model artifacts and MCP responses. Neither proves live model quality. Run a real brief + three files + questions + accepted plan + candidate + acceptance cycle after the gateway/model are configured, including cancellation, lease loss and revision conflict. Record timings, model, source hashes and actual output before declaring the blueprint's Codex gate complete.

The Python runtime must load its standard-library XML parser successfully. Check `python3 -c 'from xml.etree.ElementTree import fromstring; fromstring("<ok/>")'` before configuring `LANKA_PYTHON`. A Python executable with a broken Expat linkage cannot read Office sources. In the local Mac acceptance, `/usr/bin/python3` passed; the Homebrew Python had an Expat loading error. No machine-wide Python settings were changed.


## Resumable local review worker

The folder review worker now supports a private checkpoint and persistent Codex thread resume; see [the implementation and limits](../docs/PRODUCT_V11.md). This does not change the ephemeral cloud-task worker described above. Reuse the same project path, dedicated Codex home and model after a graceful stop. The runtime must be separate from shared documents; it can contain Codex credentials and history. An existing foreign or unmarked nonempty home is rejected. The 20-inference limit survives restart. Stale locks after a hard crash require an operator to confirm the old worker has stopped before removing them.

Run `node --test runtime/review-checkpoint.test.mjs runtime/app-server.test.mjs runtime/worker.test.mjs` from the repository root, plus `npm run test:project` for the real local MCP/HTTP recovery scenario. Model responses are injected in these tests; live authenticated App Server resume remains unverified.
