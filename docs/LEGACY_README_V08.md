# Историческое описание раннего прототипа

Этот текст сохранён для истории. Актуальные команды и границы продукта — в [README](../README.md).

Серверное хранение: [проверяемый перенос файловой библиотеки в PostgreSQL](../docs/LOCAL_LIBRARY_MIGRATION.md). Перенос включается явно; рабочая библиотека владельца пока не переключена.

Текущее обновление: [личный чат с установленным Codex](../docs/planning/CHAT_IMPLEMENTATION.md), [живые проверки](../docs/planning/CHAT_ACCEPTANCE.md), [локальный запуск](../docs/LOCAL_CHAT_SETUP.md). Исторические разделы ниже описывают соответствующие этапы, а не все возможности текущего локального режима. Focus 2 остаётся default; Focus 3 — candidate.

**Новое уточнение цели:** [презентации за минуты и простая работа агентов](../docs/planning/SIMPLE_PRODUCT_GOAL.md). Сценарии 15/5 минут — измеряемые цели, не достигнутые показатели; разработка продолжается.

# Lanka Studio

Текущая цель и выполнение: [GOAL_TRACKER](../docs/planning/GOAL_TRACKER.md). По последнему поручению владельца проведена [симуляция большой компании](../docs/planning/COMPANY_SIMULATION.md) и возобновлена разработка. Реальные интервью остаются будущей проверкой гипотез; их ожидание больше не блокирует код.

Актуальный пакет следующей разработки: [план открытой корпоративной Lanka](../docs/planning/README.md) — 38 пользовательских историй, сверка требований, архитектура/БД/MCP, контракт настоящего агентного чата, ранняя проверка и 28 инженерных пакетов. Это план реализации; фактическая готовность и доказательства отделены от будущих возможностей.

Version 0.8. [Pilot implementation, operating guide and gaps](../docs/PRODUCT_V08.md). Functional pilot of an agent-led enterprise presentation workspace. Product goal and implementation boundaries at that stage: [GOAL.md](../GOAL.md). Earlier collaboration/chat/UI plan: [PRODUCT_WORKSPACE_V4.md](../docs/PRODUCT_WORKSPACE_V4.md). Prior product/runtime blueprint: [PRODUCT_BLUEPRINT_V3.md](../docs/PRODUCT_BLUEPRINT_V3.md). Source PRDs and architectural review are in `docs/`; the planning package above records subsequent changes in requirements and current implementation evidence.

## Run and build

Node >=22.13, npm. Install with `npm ci`. Copy `.env.example` to `.env` if using an inference provider; never commit secrets. `npm run dev` runs the Vinext/Cloudflare development environment. `npm run db:generate` generates schema migrations. Hosted Sites provisions D1 `DB`, R2 `BUCKET`, applies migrations and supplies authenticated-user headers.

`npm run test:domain` checks state transitions, role isolation, concurrency, immutable releases, Markdown intake, native PPTX structure and Unicode PDF export using a SQLite-backed D1 test adapter. `npm run build` produces Worker and client output; deployment helpers are supplied by Sites. Do not expose the raw Worker while trusting spoofable identity headers: it must sit behind an authentication dispatcher that removes and replaces them.

## Repository structure

- `lib/domain`: canonical schema, proposal invariants, CreatPPT intake adapter, deterministic shared scene geometry and font metrics.
- `lib/server`: authenticated commands, D1 transactional persistence and configured provider adapter.
- `app/api/studio`: browser read/write commands; same-origin JSON writes.
- `app/api/agent`: persistent start/execute/cancel operations, history and daily attempt allowance.
- `app/api/assets`: bounded authenticated uploads and authorized file reads.
- `app/api/mcp`: stateless JSON-response Streamable HTTP MCP subset; same services, no approval/publication tools.
- `components/studio.tsx` and dedicated boards: slide inspector with direct editing/autosave/undo, narrative map, agent proposals, visual review, template catalog, sources and releases.
- `lib/export.ts`: PptxGenJS and pdf-lib adapters sharing scene layout.
- `db/schema.ts`, `drizzle/`: authoritative SQL schema and generated migrations.
- `scripts/mcp-stdio.mjs`: local stdio bridge for an appropriately authenticated gateway.

## Agent workflows

The file workflow works without provider credentials: export a packet from a saved deck → give it and a task to your approved agent → import proposal JSON → review selected slide changes. Packet v2 includes a `requestId`; preserve it for replays of the same proposal. Older packets receive a deterministic proposal key on import. The packet includes source excerpts, so the user must choose an approved agent environment.

Embedded inference needs server-side `LLM_API_URL` (full `/chat/completions` endpoint), `LLM_MODEL`, `LLM_API_KEY`. It reads the saved brief, the full title/intent outline, selected slide contents and referenced source excerpts, accepts bounded JSON proposals, and rechecks the revision after inference. No arbitrary tools, URLs or code from model output are executed. No model is configured by default and no demo content is represented as AI-generated. Runs persist before execution; an atomic write fence prevents cancelled, expired or stale runs from committing a proposal. See [docs/AGENT_RUNS.md](../docs/AGENT_RUNS.md) for the protocol, retry semantics and limits.

Remote MCP requires an approved authentication gateway forwarding trusted Site user identity. The implementation includes a stdio bridge using `LANKA_MCP_URL` and `LANKA_ACCESS_TOKEN`. A direct Site URL and a generic API key are not enough: finish the gateway's delegated authentication integration first. Live Codex/Qwen OAuth interoperability is not yet verified. File-based agent exchange is the currently ready integration path.

The browser user session is a privileged principal: an external client with that full session could call the browser API. MCP tool allowlisting is not cryptographic proof of a human. Enterprise separation requires scoped delegated credentials and a separate approval identity (tracked in GOAL).

## Limits and reliability

40 slides/document, 30 sources, 5 MB/image, 200 KB/text source, first 12k characters as an agent excerpt, 8 chart categories, 12 pending proposals and 300 comments. SQL aggregates capped at 900KB; immutable revisions and events are separate. Document commands carry actor-scoped idempotency keys; the browser retries a network failure once using identical bytes. HTTP errors are not automatically retried. MCP writes require `requestId`. The persisted receipt and document effect commit together; replay rechecks current access. R2 upload and D1 insert use cleanup compensation, not a cross-service transaction. Restoring a revision creates a new revision and clears approval. Defaults: 20 agent attempts per user and 100 per Site per UTC day, including cancelled/failed attempts. Configure `AGENT_DAILY_RUN_LIMIT` and `AGENT_SITE_DAILY_RUN_LIMIT` server-side. One active task per deck; 64k input characters, 7k maximum output tokens. These are usage limits, not a monetary spending guarantee. Cancelling prevents a late proposal write but does not guarantee that the provider stops computing or billing. HTTP execution is not a durable production queue: abandoned tasks expire and are never automatically redispatched. No full PPTX import, brand extraction or SSO/SCIM in this pilot.

Exports are produced in the browser from the server's saved snapshot. They are downloadable artifacts, not immutable stored release blobs. Releases freeze the AST/brand and refer to immutable source objects; a versioned renderer and stored export hashes are required for long-term byte reproducibility.

PDF embeds DejaVu Sans. PPTX uses that font name and may reflow when the consumer doesn't have the font. Charts are editable shapes, not Office chart workbooks. Existing accessible documents can be cloned through JSON with remapped source references; moving JSON between separate instances requires reuploading source files.

## Open source

The product owner requires a complete self-hosted deployment under company control. The architecture, current gaps, and proposed open-release contract are in [Open workspace strategy](../docs/OPEN_WORKSPACE_STRATEGY.md). This is a development target: the current worker-only Compose file does not deploy the full application, and a project-level license has not yet been added. The existing hosted deployment remains one deployment option.

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Dependencies are pinned in `package-lock.json`. We reuse published modules rather than copying unreviewed repository trees. Presenton informed architecture; its code is not included. No PPTist AGPL code is included.

## Historical review-first change in 0.3 (manual-edit policy superseded in 0.5)

Slides have no direct content controls. Use the separate correction dialog to prepare a proposal, then inspect before/after and accept selected slides. The saved brief and optional slide intent fields make the argument visible; deterministic narrative checks assess completeness only. Two additional shared-scene compositions (statement and steps) and the template catalog improve the starting visual vocabulary. Enterprise BrandPack onboarding and general structural change groups remain planned in the blueprint.

## Task workflow in 0.4

The home screen now creates persistent presentation tasks from a brief and files. A task pauses for clarification and human acceptance of its story plan, then presents a full candidate deck and critique for human acceptance. Source extraction supports bounded text from PDF/DOCX/PPTX/XLSX with locators; this does not import their layouts or styles. Agent proposal review remains available after creation; human direct editing was added in 0.5.

The actual pinned Codex App Server worker, isolation settings, source extraction and bounded critique/repair loop are in [`runtime/`](../runtime/README.md). It runs outside the Cloudflare Worker and calls 11 new task tools through the same MCP endpoint (18 tools total). Task records and events survive page closure; leases, deadlines and receipts fence competing, cancelled and stale writes. New task attempts have their own maximum of 10 claims; the older Chat Completions daily allowance does not apply to them. Retry restarts the current phase with saved answers/plan, not the original Codex thread.

Codex is installed and its protocol was started locally. No authenticated model/gateway or external worker is configured, so newly queued tasks will wait for an executor. The older one-shot inference adapter remains a separate path. Complete progress, remaining PRD gaps and acceptance steps: [IMPLEMENTATION_PROGRESS_V04.md](../docs/IMPLEMENTATION_PROGRESS_V04.md).

## Editing and cloud preparation in 0.5

Click a slide to edit its text/data in the right inspector. Local preview updates immediately; a 900ms debounce saves with the base revision. Undo/redo, save status, retry and downloading unsaved JSON make failures visible; a save acknowledgment never replaces newer typing. This is managed slide editing, not free-form canvas geometry or rich-text selection. Agent controls are now on the left; review/approval stays on the right. Library filters distinguish owned and shared decks, with existing role-based links and grants. Organization membership/invitations are not implemented; access to the private Site still needs separate authorization.

External deployment preparation is in [deploy/README.md](../deploy/README.md): Cloudflare Access JWT verification, separate task-only worker identity, generated Worker/D1/R2 and Fly configurations, and a real migration plan for Neon. No external resources, model credentials or running worker have been configured here. This gateway is specific to the external deployment and does not change the private Sites dispatcher.

The original in-app one-shot panel is not yet a streaming Codex chat. Workspace tenancy, persistent conversations/SSE, browser-render feedback, voice transcription and certified BrandPacks remain explicit next stages. [PRD/UI/collaboration plan](../docs/PRODUCT_WORKSPACE_V4.md) and [eight-project OSS capability review](../docs/EDITOR_REUSE_REVIEW_V05.md) distinguish existing code from planned work.

## Client project folders (0.6 foundation)

The deployment goal is now an individually scoped client project, with customer-controlled storage. The web editor can export a portable ZIP including verified source bytes. A separate local stdio MCP works with one configured folder and reuses the canonical document, proposal checks and export engine. It does not search other clients or provide approval/publication tools. `npm run build:mcp` builds it; `npm run test:project` checks the real protocol.

[Client project requirements and setup](../docs/CLIENT_PROJECTS_V06.md) distinguish this working local path from the still-planned file-backed web editor and storage synchronization. Existing web data stays in D1/R2. A folder connection is not an OS sandbox for an agent's other tools.

## Design and shared local folder in 0.7

Atelier v1 is the default design for new Markdown/demo documents; existing unversioned documents retain Classic. Design and brand are separate inputs to the shared SVG/PDF/PPTX scene. The inspector and template gallery can switch design without rewriting slide content.

`npm run build:mcp` now builds both the local MCP and the local browser editor. Run `npm run start:project -- --root /absolute/project` and connect Codex stdio to the same root. Direct edits, human comments and proposal acceptance persist to one project.json with local locking and revision checks. The local UI is owner-only on loopback, not a remotely shared enterprise service. The hosted editor still uses D1/R2; it does not synchronize with that local folder.

Read [ARCHITECTURE_AND_DESIGN_V07.md](../docs/ARCHITECTURE_AND_DESIGN_V07.md) for the actual StoryPlan/DeckDoc separation, OSS reuse, comparison with direct PPTX and remaining Brand Onboarding/storage work.

### Shared local library through MCP

External stdio clients can now work directly on the same PostgreSQL document as the local editor. In the document’s Agent panel, expand “Подключить своего агента через MCP” for its scoped launch configuration. The original `--root` folder mode remains supported. To start from the UI, choose “Создать пустую” with a design profile. Read `get_project`, then use `populate_draft` when `canPopulate` is true; read `get_design_profile` first. The operation preserves the chosen name/brand/design, rejects changed or discussed drafts, and safely replays the same request ID. Run `npm run test:library-mcp` after local chat storage setup to verify the real protocol/editor roundtrip. This is a trusted same-OS-user local connection, not remote corporate delegation. See [acceptance evidence and limits](../docs/planning/SHARED_MCP_ACCEPTANCE.md). `populate_draft` can retain prompt context as optional `briefing`, distinguishing supplied information from assumptions. `render_slides` returns revision-bound PNG previews of saved slides or a pending `proposalId` without accepting it; install Poppler (`pdftoppm`) in the server PATH to enable it. An opt-in native Codex acceptance runner with exact-session `--resume-from` review is documented in that report. It uses the existing login and process-only settings; the regular UI chat still uses its supervised JSON adapter.
