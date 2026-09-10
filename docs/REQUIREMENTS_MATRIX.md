# Матрица реализации требований Lanka Studio

> Поправка заказчика 05.09.2026: inline-редактирование исключено; используется отдельная точная корректировка → proposal → accept. Полная карта решений и статус 0.3: [PRODUCT_BLUEPRINT_V3.md](PRODUCT_BLUEPRINT_V3.md). Остальные строки ниже сохраняют детализацию аудита 0.2.

Дата: 5 сентября 2026. Основание: текущий код 0.2; требования v2 §10 и дополнительный Brand/Onboarding scope v1.2. Исходные PRD не изменены.

**Статусы:** «Базовый механизм» — узкое требование поддержано текущим прототипом; «Частично» — есть заготовка, но acceptance целиком не выполнен; «Не реализовано» — нет нужного workflow. Ни один статус не означает прохождение enterprise-пилота. Браузерные, live Codex и эксплуатационные проверки не проводились в этом аудите.

## PRD v2 §10

| ID | Требование | Acceptance исходного PRD | Статус | Что есть / что осталось |
|---|---|---|---|---|
| PR-ORG-001 | Tenant, Brand Library, Workspace и Deck ACL | Любой read/write проверяет tenant и effective permission | Частично | Есть ACL одного документа; tenant/workspace отсутствуют. |
| PR-ORG-002 | Template принадлежит tenant | Workspace не создаёт независимую certified копию | Не реализовано | Нужен tenant/workspace, policy и роли организации. |
| PR-ORG-003 | Internal share link | Пользователь без access получает deny, ссылка сама право не создаёт | Частично | Права документа проверяются; доступ к Site остаётся отдельным уровнем. Полного tenant-sharing нет. |
| PR-ORG-004 | External release link policy | Expiration/watermark/download policy применяются к release | Не реализовано | Нужен tenant/workspace, policy и роли организации. |
| PR-ORG-005 | Audit | Создание, agent writes, comments, accepts, approvals и publish имеют actor/time/object | Частично | Есть events доменных изменений; нет единого trace run/tool/render/publication и полной истории этапов. |
| PR-ORG-006 | Data classification | Deck наследует/повышает classification от inputs; понижение требует permission | Не реализовано | Нужен tenant/workspace, policy и роли организации. |
| PR-DECK-001 | Создать deck из brief | Создаётся `DeckRecord`, empty revision и AgentRun либо manual draft | Частично | Создание из Markdown/JSON; агентной обработки брифа и файлов нет. |
| PR-DECK-002 | Immutable revision | Сохранённая revision не меняется; новая команда создаёт следующую | Частично | Контентные ревизии immutable; lifecycle candidate/branch и command-log из PRD ещё не полные. |
| PR-DECK-003 | Stable IDs | Block/source/comment anchors сохраняются после reorder/recipe switch | Частично | Стабильны ID слайдов/метрик; универсальных блоков и anchors нет. |
| PR-DECK-004 | Checkpoint | Можно именовать revision и восстановить как новый branch/draft | Частично | Есть restore как новая ревизия; именованных checkpoints и branch/draft нет. |
| PR-DECK-005 | Derived deck lineage | Regular update/audience variant хранит origin | Не реализовано | Нужны дополнительные сущности/операции жизненного цикла документа. |
| PR-DECK-006 | Soft delete/restore | Audit и releases не исчезают | Не реализовано | Нужны дополнительные сущности/операции жизненного цикла документа. |
| PR-AGENT-001 | Embedded agent P0 | Создание из brief не требует внешнего IDE | Не реализовано | Нужен готовый агентный runtime, его execution adapter и product workflow. |
| PR-AGENT-002 | Remote MCP | Внешний client получает tools/resources после OAuth/scoped auth | Частично | Есть HTTP MCP subset; OAuth/scoped grant/revocation и SDK transport не внедрены. |
| PR-AGENT-003 | CLI checkout | Coding-agent получает deterministic working directory | Частично | Есть JSON packet и stdio bridge; deterministic checkout, YAML round-trip и CLI validate/render/submit отсутствуют. |
| PR-AGENT-004 | One Tool Service | Embedded/MCP/CLI проходят одинаковые validation/permissions | Частично | Browser/MCP используют command service; CLI отсутствует, не все run/tool объекты унифицированы. |
| PR-AGENT-005 | Versioned skills | Run фиксирует exact skill packages | Не реализовано | Нужен готовый агентный runtime, его execution adapter и product workflow. |
| PR-AGENT-006 | Bounded run | Max duration/iterations/tool calls/cost enforced server-side | Частично | Есть TTL, timeout, размеры и дневные попытки; нет лимитов tool calls/repair/cost с durable execution. |
| PR-AGENT-007 | No publish tool | Попытка agent publish возвращает authorization denial | Частично | MCP allowlist запрещает publish; отдельной agent identity нет, полная пользовательская сессия остаётся привилегированной. |
| PR-AGENT-008 | Needs-input state | Агент задаёт structured questions вместо выдумывания данных | Не реализовано | Нужен готовый агентный runtime, его execution adapter и product workflow. |
| PR-AGENT-009 | Run observability | Пользователь видит stages, sources, operations, outputs и cancel | Частично | Есть история статусов и cancel; нет плана, этапов, вопросов, источников действий и промежуточных артефактов. |
| PR-AGENT-010 | Provider independence | Skill and DeckDocument не содержат provider-specific types | Частично | Документ отделён от модели; production adapter Codex и versioned skill contract не реализованы. |
| PR-REVIEW-001 | Proposal from base revision | Main не меняется до accept | Частично | Проверено тестами для замен существующих слайдов; полноценный candidate revision и greenfield proposal ещё отсутствуют. |
| PR-REVIEW-002 | Semantic diff | Text/data/source/recipe/asset changes понятны без JSON diff | Частично | Читаемый title/body diff; остальные поля в JSON, без пользовательских категорий данных/источников/визуалов. |
| PR-REVIEW-003 | Visual diff | Для изменённых slides доступны before/after thumbnails | Не реализовано | Нужен proposal/review workflow с доменными связями и серверными правами. |
| PR-REVIEW-004 | Partial accept | Можно применить независимый change group; dependencies проверяются | Частично | Можно принять целые слайды; блоки/операции/dependencies не поддержаны. |
| PR-REVIEW-005 | Rebase/conflict | Human change не перетирается; конфликт показывается | Частично | CAS и before-images предотвращают перезапись; нет сохраняемого rebase/conflict workflow для proposal. |
| PR-REVIEW-006 | Comments to agent | Unresolved comments можно передать в AgentRun | Частично | Unresolved comments попадают в snapshot запроса; assignment и связанный comment→delta цикл отсутствуют. |
| PR-REVIEW-007 | Comment anchoring | Anchor переживает layout change через stable block ID | Частично | Anchor по slideId; block/text anchors отсутствуют. |
| PR-REVIEW-008 | Review status | Requested/changes-requested/approved относится к revision | Частично | Есть approvedRevision; requested/changes-requested/required approvals отсутствуют. |
| PR-REVIEW-009 | Separation of duties | Agent и author не могут закрыть required publisher approval | Не реализовано | Нужен proposal/review workflow с доменными связями и серверными правами. |
| PR-EDIT-001 | Уточнено: отдельная корректировка text/list/metric | Candidate preview → proposal → human accept | Изменённое требование реализовано для слайда | Inline исключён; формы текста, чисел, заметок и композиции находятся в отдельном диалоге. Block-level proposals ещё нет. |
| PR-EDIT-002 | Compatible recipe switch | UI показывает только recipes, принимающие текущие blocks | Частично | Семь фиксированных layout; нет декларативного контракта совместимости blocks/recipes. |
| PR-EDIT-003 | Reorder | Slide/block order changes atomically | Частично | Порядок слайдов сохраняется атомарно; semantic block reorder отсутствует. |
| PR-EDIT-004 | Asset replace/crop | Preview/PDF crop identical | Частично | Asset можно заменить; управляемого crop/focal point нет. |
| PR-EDIT-005 | Source/data binding | Inspector показывает date, provenance, freshness | Частично | Можно привязать файл, загрузить CSV; нет snapshot selectors, source dates/freshness и полноценного provenance. |
| PR-EDIT-006 | Chart type switch | Запрещённые mappings недоступны | Не реализовано | Текущая фиксированная схема/редактор не поддерживают эту возможность. |
| PR-EDIT-007 | Notes | Notes доступны reviewer, не попадают в PDF по умолчанию | Базовый механизм | Notes сохраняются и не включаются в обычный PDF; базовый механизм реализован. |
| PR-EDIT-008 | No arbitrary geometry | Authoring command schema не содержит x/y | Базовый механизм | Текущая входная схема не принимает произвольную геометрию; базовый механизм реализован. |
| PR-TPL-001 | Versioned package | Deck pins immutable template version | Частично | Снимок цветов бренда закреплён в документе; immutable package со всеми версиями/хешами отсутствует. |
| PR-TPL-002 | Tokens/components/recipes | Runtime не исполняет tenant code | Частично | Tenant code не исполняется; tokens/components/recipes package не реализован. |
| PR-TPL-003 | Agent guide | `get_template_contract` объясняет use/anti-patterns/examples | Не реализовано | Нужен versioned Template/Brand Pack и onboarding/certification pipeline. |
| PR-TPL-004 | Image style profile | Generation request получает locked brand style constraints | Не реализовано | Нужен versioned Template/Brand Pack и onboarding/certification pipeline. |
| PR-TPL-005 | Fixtures | Candidate не сертифицируется при blocking fixture failure | Не реализовано | Нужен versioned Template/Brand Pack и onboarding/certification pipeline. |
| PR-TPL-006 | Certification | Только Brand role переводит candidate в certified | Частично | Ручной certified flag без отдельного Brand Admin и полноценного certification gate. |
| PR-TPL-007 | Template switch | Migration report показывает incompatible blocks | Частично | Есть смена бренда; нет migration report несовместимых блоков. |
| PR-TPL-008 | Assisted onboarding | Extractor + agent создают candidate package из references | Не реализовано | Нужен versioned Template/Brand Pack и onboarding/certification pipeline. |
| PR-RENDER-001 | Authoritative render | Slide images и PDF используют тот же RenderPlan | Частично | Общая геометрия scene используется SVG/PDF; authoritative page-image service и визуальная приёмка отсутствуют. |
| PR-RENDER-002 | Real font measurement | Overflow определяется с approved font binaries | Частично | Используются извлечённые метрики двух шрифтов; нет полного контракта approved fonts/missing glyphs и browser measurement. |
| PR-RENDER-003 | Deterministic hard lint | Same inputs → same blocking issues | Частично | Есть детерминированные content/reference/overflow проверки; не весь набор hard issues из PRD. |
| PR-RENDER-004 | Repair loop | Agent использует documented fallback, не arbitrary coordinates | Не реализовано | Нужен серверный render/repair/vision pipeline и manifest. |
| PR-RENDER-005 | Full final vision pass | Перед handoff проверены все slide images | Не реализовано | Нужен серверный render/repair/vision pipeline и manifest. |
| PR-RENDER-006 | Bounded vision iterations | Policy limit не допускает бесконечный loop | Не реализовано | Нужен серверный render/repair/vision pipeline и manifest. |
| PR-RENDER-007 | Slide images API | `render` возвращает references на page images + issues | Не реализовано | Нужен серверный render/repair/vision pipeline и manifest. |
| PR-RENDER-008 | Visual fingerprint | Release manifest фиксирует per-page perceptual/geometry fingerprint | Не реализовано | Нужен серверный render/repair/vision pipeline и manifest. |
| PR-VIS-001 | Brand assets first | Skill ищет approved library до external generation | Не реализовано | Нужны Visual Service, Brand Library и image provider broker. |
| PR-VIS-002 | Native structural visuals | Steps/flow/comparison не rasterize без причины | Частично | Есть редактируемые shapes для диаграмм и композиций; полноценные semantic flow/steps/comparison blocks отсутствуют. |
| PR-VIS-003 | VisualIntent | Для visual block хранится purpose/type/style constraints | Не реализовано | Нужны Visual Service, Brand Library и image provider broker. |
| PR-VIS-004 | Generation broker | Provider credential недоступен agent/client | Не реализовано | Нужны Visual Service, Brand Library и image provider broker. |
| PR-VIS-005 | Candidates | Генерация создаёт 2–3 immutable candidates | Не реализовано | Нужны Visual Service, Brand Library и image provider broker. |
| PR-VIS-006 | Provenance | Provider/model/request/inputs/policy/actor/run recorded | Частично | Upload содержит хеш/имя/дату; generation provider/model/request/policy/rights provenance отсутствует. |
| PR-VIS-007 | DLP and classification | Confidential content не уходит запрещённому provider | Не реализовано | Нужны Visual Service, Brand Library и image provider broker. |
| PR-VIS-008 | License state | Unknown/restricted asset может блокировать external release | Не реализовано | Нужны Visual Service, Brand Library и image provider broker. |
| PR-VIS-009 | Image quality lint | Resolution, aspect, artifacts, text/logo/face policy проверяются | Не реализовано | Нужны Visual Service, Brand Library и image provider broker. |
| PR-VIS-010 | No regeneration on publish | PDF использует выбранный blob hash | Частично | Существующие изображения не генерируются при экспорте; целевого server publication и generated asset flow ещё нет. |
| PR-DATA-001 | Immutable CSV/JSON snapshot | Dataset hash и schema сохранены | Частично | Блоб CSV/JSON сохраняется; типизированного DataSnapshot со schema и mappings нет. |
| PR-DATA-002 | Units and types | Metric/chart mapping validates | Частично | Метрики и значения chart числовые; типы dataset fields, единицы и mapping validation неполные. |
| PR-DATA-003 | Freshness | Policy marks stale data warn/block | Не реализовано | Нужны DataSnapshot/SourceSegment, датировки, типизированные привязки и provenance. |
| PR-DATA-004 | Source for numbers | Asserted metric без source/date flagged | Частично | Предупреждение при отсутствии источника у слайда; проверки каждого утверждения, дат и selector нет. |
| PR-DATA-005 | Frozen publication | Manifest содержит exact snapshot IDs/hashes | Частично | JSON release содержит значения и references; полного manifest со snapshot IDs/hashes нет. |
| PR-DATA-006 | Source excerpts | Agent sees bounded excerpts, not entire confidential corpus by default | Частично | Embedded запрос использует ограниченные excerpts; tenant classification и выборочная выдача через Tool Service не реализованы. |
| PR-DATA-007 | Prompt-injection boundary | Source body treated as untrusted data, not instructions | Частично | Промпт помечает источники как данные; sandboxed tool loop и adversarial acceptance отсутствуют. |
| PR-SRC-001 | Immutable source upload | Original blob, checksum, classification, uploader and parser version recorded | Частично | Сохраняются blob/hash/owner/дата; classification и parser/extraction version отсутствуют. |
| PR-SRC-002 | Supported P0 formats | TXT/Markdown, text PDF, DOCX, PPTX-as-source, CSV/JSON/XLSX and PNG/JPEG/SVG follow explicit pipelines | Частично | Поддержаны TXT/MD/JSON/CSV/PNG/JPEG; Office/PDF/XLSX/SVG pipelines отсутствуют. |
| PR-SRC-003 | Stable source anchors | Claim can cite page/paragraph, slide/shape or sheet/cell range after normalization | Не реализовано | Нужен sandboxed source ingestion с версионированными anchors и отчётом. |
| PR-SRC-004 | Safe extraction | Macros, active content, external links and archive bombs are never executed | Частично | Размеры ограничены, активные Office/SVG форматы не принимаются; целевого sandboxed extraction ещё нет. |
| PR-SRC-005 | Extraction report | UI/agent sees complete/partial/failed status, warnings and unsupported content | Не реализовано | Нужен sandboxed source ingestion с версионированными anchors и отчётом. |
| PR-SRC-006 | Scanned-document handling | Missing text layer is detected; OCR/vision requires approved adapter and confidence, never silent fallback | Не реализовано | Нужен sandboxed source ingestion с версионированными anchors и отчётом. |
| PR-SRC-007 | Spreadsheet semantics | Formulas and cached values are recorded; external connections/macros are not executed | Не реализовано | Нужен sandboxed source ingestion с версионированными anchors и отчётом. |
| PR-SRC-008 | Citation trace | Every quoted/extracted fragment preserves source ID, anchor and extraction version | Не реализовано | Нужен sandboxed source ingestion с версионированными anchors и отчётом. |
| PR-PUB-001 | Revision-specific review | Approval invalidated by content-changing revision | Базовый механизм | Правка снимает approvedRevision; базовый механизм реализован и проверен тестами. |
| PR-PUB-002 | Authoritative preflight | Publish reruns hard checks | Частично | Повторяются существующие lint/overflow проверки; нет полного серверного render preflight. |
| PR-PUB-003 | Immutable PDF release | Existing artifact never overwritten | Частично | Есть immutable JSON release; сохраняемого серверного PDF artifact нет. |
| PR-PUB-004 | Manifest | Includes deck/template/skills/renderer/fonts/assets/data/approvals hashes | Не реализовано | Нужны Publication Service, роли и immutable artifact/manifest. |
| PR-PUB-005 | Agent denied | No agent token can publish | Частично | MCP не публикует; криптографически отдельный agent principal с запретом human endpoints отсутствует. |
| PR-PUB-006 | Share controls | External link follows classification policy | Не реализовано | Нужны Publication Service, роли и immutable artifact/manifest. |
| PR-EVAL-001 | Versioned benchmark corpus | Briefs, sources and expected constraints are immutable/versioned | Не реализовано | Нужны benchmark corpus, scorer/rubric, regression gate и измерение пилота. |
| PR-EVAL-002 | Skill regression | Skill/model/template change runs benchmark before promotion | Не реализовано | Нужны benchmark corpus, scorer/rubric, regression gate и измерение пилота. |
| PR-EVAL-003 | Deterministic metrics | Blocking issue rate, source coverage and render success automatic | Не реализовано | Нужны benchmark corpus, scorer/rubric, regression gate и измерение пилота. |
| PR-EVAL-004 | Human rubric | Narrative, audience fit, visual relevance and brand quality scored | Не реализовано | Нужны benchmark corpus, scorer/rubric, regression gate и измерение пилота. |
| PR-EVAL-005 | Traceability | Each eval result pins skill/model/template/compiler versions | Не реализовано | Нужны benchmark corpus, scorer/rubric, regression gate и измерение пилота. |
| PR-EVAL-006 | Pilot dashboards | First proposal acceptance and comment-to-fix iterations visible | Не реализовано | Нужны benchmark corpus, scorer/rubric, regression gate и измерение пилота. |

## Дополнительные требования Brand Onboarding из v1.2

Сокращённое описание Template onboarding в v2 не закрывает evidence/authority, weighted coverage, effective inheritance и first-setup процесс с интегратором. Эти требования сохраняются в целевом плане. Включены также две строки P1, чтобы не спутать их с P0.

| ID | Требование | Приоритет | Acceptance исходного PRD | Статус |
|---|---|---|---|---|
| PR-BRAND-001 | Tenant-level Brand Library | P0 | Templates/assets/fonts/guides centrally governed | Не реализовано |
| PR-BRAND-002 | Immutable BrandPackRelease manifest | P0 | Pins exact component versions and hashes | Не реализовано |
| PR-BRAND-003 | Brand Profile | P0 | Colors, typography, spacing, logo, page geometry, image style | Частично: только цвета/подпись |
| PR-BRAND-004 | Writing Guide | P0 | Tone, terminology, prohibited phrases, product naming | Не реализовано |
| PR-BRAND-005 | Archetype Set | P0 | Contracts and curated examples for allowed deck types | Не реализовано |
| PR-BRAND-006 | Reference Corpus | P0 | Slides/materials have authority/status/date/classification | Не реализовано |
| PR-BRAND-007 | Asset Library | P0 | Assets include rights/provenance/search metadata | Не реализовано |
| PR-BRAND-008 | Template Packages | P0 | Tokens/components/recipes/policies/fixtures/agent guides | Не реализовано |
| PR-BRAND-009 | Workspace subscription | P0 | Workspace sees allowed releases; deck pins exact release | Не реализовано |
| PR-BRAND-010 | Subbrand inheritance | P0 | Resolved at certification into effective release | Не реализовано |
| PR-BRAND-011 | Rebrand migration preview | P1 | Impact by deck/slide/block and visual diff | Не реализовано |
| PR-ONB-001 | Onboarding run entity | P0 | Status, materials, candidates, decisions, tests and audit are durable | Не реализовано |
| PR-ONB-002 | Sandboxed import | P0 | Macros/network/zip bombs/active SVG blocked; time and size limits | Не реализовано |
| PR-ONB-003 | Material classification | P0 | template/reference/brandbook/font/logo/asset/writing-guide types | Не реализовано |
| PR-ONB-004 | Authority labels | P0 | normative/recommended/illustrative/exception/obsolete/unknown | Не реализовано |
| PR-ONB-005 | Candidate evidence | P0 | Every candidate links to page/slide/object and extraction version | Не реализовано |
| PR-ONB-006 | Conflict resolution | P0 | Conflicting colors/rules/layouts shown explicitly, never silently merged | Не реализовано |
| PR-ONB-007 | Brand profile generation | P0 | Human can accept/edit/reject each candidate | Не реализовано |
| PR-ONB-008 | Recipe clustering | P0 | Shows cluster members, weighted coverage, exceptions and slot proposal | Не реализовано |
| PR-ONB-009 | Agent guide generation | P0 | Each recipe has when-to-use, required/optional slots, anti-patterns and examples | Не реализовано |
| PR-ONB-010 | Fixture/golden runner | P0 | Certification blocked on unresolved blocking fixtures | Не реализовано |
| PR-ONB-011 | Test deck | P0 | Real/approved brief runs through production skills and review rubric | Не реализовано |
| PR-ONB-012 | Human-only certification | P0 | Agent identity cannot call endpoint or obtain scope | Не реализовано |
| PR-ONB-013 | Full self-serve onboarding | P1 | Brand Admin can complete flow without our implementation team | Не реализовано |

## Приёмочные сценарии v2 §32

Каждый сценарий ниже — самостоятельная приёмка; прохождение отдельных unit/integration tests не закрывает его полностью.

| Сценарий | Оценка и недостающие части |
|---|---|
| AC-01: Agent creates greenfield board deck | Нет greenfield Codex workflow, template package, 10-slide generation, needs-input и server render. |
| AC-02: External Codex/Cursor uses same surface | MCP transport есть; OAuth/scopes, render и единые AgentRun/Proposal для внешнего клиента не готовы. |
| AC-03: YAML round-trip | Canonical YAML checkout/submit отсутствует. |
| AC-04: Human edit during agent run | Защита от overwrite проверена; stale submission отклоняется, но полноценный proposal conflict UI отсутствует. |
| AC-05: Partial acceptance | Принятие независимых целых слайдов есть; generic change groups/dependencies отсутствуют. |
| AC-06: Comment assigned to agent | Нет назначения block comment агенту и linked delta-proposal. |
| AC-07: Overflow repair | Overflow определяется; skill repair loop по template fallback chain отсутствует. |
| AC-08: Final vision critique | Final vision и typed AIQualityIssue отсутствуют. |
| AC-09: Generated image provenance | Image generation broker/candidates/provenance отсутствуют. |
| AC-10: Confidential visual denial | Tenant classification и внешний visual egress policy отсутствуют. |
| AC-11: Data snapshot publication | Файл/числа заморожены, но DataSnapshot manifest и update workflow не реализованы. |
| AC-12: Template certification | Нет fixture certification gate и отчёта Brand Admin. |
| AC-13: Agent cannot publish | MCP allowlist запрещает publish; отдельная agent identity и защита от прямого human API требуют реализации. |
| AC-14: Standalone critique | Standalone semantic critique отсутствует. |
| AC-15: Regular update lineage | Derived deck/block lineage и смысловой diff регулярного обновления отсутствуют. |
| AC-16: Internal sharing | Базовый email ACL проверен; tenant commenter и полный sharing сценарий требуют доработки. |
| AC-17: Revoked agent access | Отзыв доступа документа проверен; OAuth Agent App grant/token revocation SLA отсутствует. |
| AC-18: Source prompt injection | Источники обозначены как данные, но настоящая tool-execution изоляция и adversarial tests не выполнены. |

## Границы этой матрицы

Это полный список строк требований из указанных разделов, но не каталог всех инвариантов и NFR обоих документов. Дополнительно обязательны v2 §6, §23 и §28–29/36: изоляция арендаторов и workers, доступность, производительность, outbox/retries/DLQ, observability, backup/restore, SBOM/NOTICE, evals и реальная приёмка. Порядок закрытия описан в IMPLEMENTATION_GAP_REVIEW.md.
