# Validation — pilot 0.8

Current validation and limitations: [PRODUCT_V08.md](PRODUCT_V08.md).

The 0.8 acceptance run covers mandatory briefing, assumptions, cloud and local semantic proposals, reply linkage, source snapshots, revision protection and same-thread feedback processing with an injected model. Browser/mobile UI, live model authentication and enterprise deployment are not verified.

## Current 0.5 checks

Validated on 2026-09-05:

- **48 domain/integration tests passed**: previous coverage plus autosave acknowledgment preserving newer typing/other documents, continued save from the new revision, stale-write rejection and schema-normalized object key ordering.
- **7 runtime tests passed** after the Cloudflare service-auth transport change; model/MCP responses are injected, not live inference.
- **4 external deployment tests passed**: real locally signed RSA JWT verification, audience/expiry/corruption rejection, forged identity headers, task-only worker restrictions, oversized-body rejection and configuration generation without public Worker bypass. These tests do not contact a Cloudflare account.
- TypeScript and the production Worker/client build passed. The external entry point compiled with an offline esbuild check using Node-compatible imports; this is not a Cloudflare runtime acceptance test. Wrangler dry-run could not be completed because its network approval was cancelled. External deployment remains unverified.

No browser visual/e2e acceptance, Docker run, live cloud account setup, live Codex generation, shared coworker session or voice pipeline was verified in this change. Prior six extraction tests are a 0.4 baseline and were not rerun for this UI/auth change.

## Previous 0.4 checks

Validated on 2026-09-05:

- **46 domain/integration tests passed** using generated migrations 0000, 0001 and 0002 in the SQLite-backed D1 adapter. Includes atomic task/deck creation, competing leases, idempotent claim/acceptance, questions and answers, cancellation/expiry, source-anchor validation, accepted-intent preservation, candidate separation and access/revision conflicts.
- **7 runtime tests passed**: JSONL event races, exact-turn interruption, approval denial, identical-byte network retries, malformed/bounded output, question handoff, composition repair with a separate critic thread, and exhaustion of critique retries without candidate publication. The worker tests inject model/MCP responses; no live model calls.
- **6 Python extraction tests passed**: DOCX paragraph anchors, PPTX numeric fallback and actual presentation relationship order, XLSX cached formula labeling, entity rejection and unsupported images.
- TypeScript compilation passed. Build/deployment is a separate release gate; the native hosting result records its outcome.

The actual installed `codex-cli 0.153.4` initialized and answered account/read before final hardening; account, model and gateway were unconfigured. Attempts to repeat the local process check were interrupted by execution approval cancellation; the final feature configuration is covered by protocol fixtures but not a successful second live process check. No claim of live inference or hosted background execution follows from these results.

Not validated: Docker image build/run (Docker unavailable), authenticated remote MCP delegation, live inference quality, browser visual/e2e QA, Office application fidelity, enterprise isolation, backup restoration or load. Read [IMPLEMENTATION_PROGRESS_V04.md](IMPLEMENTATION_PROGRESS_V04.md) and [runtime/README.md](../runtime/README.md) for the remaining gates.

## Previous 0.3 baseline

Validated on 2026-09-05. `npm run test:domain` passed 38 tests against actual generated SQLite schema with a D1 adapter, and real PPTX/PDF libraries:

- Concurrent idempotent creates/comments; altered-key payload rejection; replay after acceptance, revision changes and access revocation.
- Receipt rollback with failed mutations and stable browser retry bytes; HTTP failures are not retried.
- Provider configuration validation, duplicate run starts, one active task per deck, atomic daily reservations per user and Site.
- Single provider invocation under competing execute requests; successful completion only creates a proposal.
- Cancellation during inference, direct transaction fencing for cancelled/overdue runs, human edits and access revocation during inference.
- Queue expiration, provider configuration changes, malformed output, HTTP errors and timeouts; no automatic redispatch.
- Run history permissions, cancellation permissions and nonrefundable attempt accounting.
- Markdown and quoted CSV parsing, strict schema and brand contrast.
- Atomic partial review; stale before-images cannot overwrite human edits.
- Owner isolation, reader permission enforcement and access revocation.
- Compare-and-swap failure leaves document, audit and revisions untouched.
- Exact revision approval, immutable releases, duplicate-release transaction rollback and restore.
- Agent command surface rejects approval/sharing and stale inference completion.
- Required-content, overflow and fabricated source checks.
- MCP initialization/discovery/authentication response and forbidden-origin behavior.
- MCP tool schemas require requestId at command level and declare every required property; audited after finding and correcting the nested proposal-schema defect.
- Generated PPTX contains native editable shape/text objects and Russian text.
- Generated PDF has expected pages, embedded fonts and extractable Russian text.
- JSON cloning remaps source IDs and preserves isolation from the original document.

Additional 0.3 coverage: backward-compatible narrative schema with bounds; explicit non-verification semantics; durable brief revisions and stale-write rejection; intent edits remain proposals until acceptance; agent snapshots include brief and whole outline; all nine catalog fixtures fit the shared scene; excessive steps fail the layout gate; the two new compositions generate native PPTX objects and PDF pages.

TypeScript compilation passed. Production Worker/client build passed. Known build notices remain: unused Node-only CreatPPT imports are externalized in the browser build, and the export chunk exceeds 500 KB. Tests apply migrations 0000 and 0001 to SQLite; the D1 test adapter executes each batch atomically. Provider tests use injected HTTP responses and deferred promises, without contacting a model service.

Not validated here: browser visual/e2e QA (not requested), live LLM execution (provider credentials not supplied), live Codex/Qwen OAuth connection, Office application fidelity, load limits, backup restoration and enterprise SSO. These are explicit next-stage acceptance gates in GOAL.md, not implied passes.

## 0.6 client-folder validation

49 domain/integration tests passed, including the portable ZIP's exact source hashes and removal of application ACL/approval. Four additional tests run actual JSON-RPC over stdio in separate MCP processes: creation and replay, cross-project denial, proposal separation and stale revisions, concurrent write/lock handling, linked state/export rejection. Final TypeScript and production build passed.

A real local MCP session created a seven-slide concept deck, ran lint/narrative completeness checks with zero issues and exported PPTX/PDF. Every PDF-rendered slide was inspected at full size; no clipping or overlap observed. This does not prove native Office fidelity or a separate Codex model run. The browser Codex page required login; direct hosted MCP returned 401. No customer storage, authenticated Codex model, external cloud deployment, distributed file locking or automatic synchronization was validated.

The hosting service rejected the attempted `mcp.path` declaration as an unsupported manifest field. It was removed before publishing; adding an HTTP route does not establish native MCP registration or authenticated access. The tested MCP demonstration uses the separate local stdio server.


## 0.7 design and local editor validation

50 domain/integration tests and 6 local MCP/HTTP integration tests passed. All nine Atelier fixture layouts fit; legacy Classic rendering remains selected for documents with no design field. Switching design preserves the story and rejects unknown designs. The real local sequence covers human HTTP save, MCP read, human feedback, MCP proposal and human HTTP acceptance in a shared project.json, with stale writes and unauthorized/cross-origin/path/Host requests rejected. PDF download from the local service was checked for the expected revision and PDF bytes. Host rejection uses a raw Node HTTP request because fetch normalizes its Host header.

TypeScript and production build passed. The standalone browser bundle compiled; unused Node-only CreatPPT imports were verified absent from that bundle. No browser UI/e2e interaction was performed.

A seven-slide concept project was created and exported through the actual stdio MCP in Atelier v1. All seven PDF-rendered slides were inspected individually; no clipping or overlap observed. The same scene is used for web SVG and PPTX, but native Office rendering fidelity was not checked. Separate Codex model inference, hosted MCP registration, corporate disk synchronization, per-client OS/container isolation and remote collaboration remain unvalidated.


v0.9: постоянные ссылки, импорт материалов и owner-specific пример покрыты интеграционными тестами; все 10 композиций Focus — fixtures. Браузерная проверка заблокирована URL-политикой среды. См. PRODUCT_V09.md.


## v0.10 / Focus 2 — 2026-09-05

58 domain/integration tests and 9 real local MCP/HTTP tests passed. TypeScript validation passed. All 11 sales PDF slides were inspected individually; final copy edits changed only slides 1 and 9 (render hashes compared), and those two were reinspected. MCP lint returned no errors, narrative issues, design-rule issues or overflow. Focus v1 was not changed. Versioned example tests verify preservation of previous edits and isolation between owners. Browser UI/mobile QA remains unavailable due to the browser URL policy rejection; it was not bypassed. Native Office fidelity and authenticated Codex model execution were not verified.


## Review-session recovery

Pinned Codex 0.153.4 `thread/resume` schema was generated locally and inspected. Runtime tests cover persistent opt-in, read-only resume, binding/lock checks, linked-file rejection and explicit failure on a missing thread. Local MCP/HTTP integration covers recovery after a proposal commits but its response is lost, continuing the same thread on the next comment, human-only acceptance and a persisted inference limit. No browser, template or presentation changes were made. Live authenticated Codex resume is not verified by these injected-model tests.

## Проверка пользовательских сценариев V12

59 доменных проверок, включая точное соответствие текстовых элементов Focus 2 полям редактирования, прошли. Production build прошёл. Изменения UI не проходили живой браузерный прогон: ограничения preview сохраняются. Подробный аудит и ручная приёмка — `docs/PRODUCT_UX_REVIEW_V12.md`.
