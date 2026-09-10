import { defaultDesign } from "@/lib/domain/design";
import { briefSchema } from "@/lib/domain/narrative";
import { z } from "zod";
import { database, bucket } from "@/db";
import { AppError, type Actor } from "./auth";
import { allow, createDeck, getDeck, resolveBrand, saveDeck } from "./store";
import { DB_NOW, fingerprint } from "./idempotency";
import {
  blankSlide,
  changedContent,
  uid,
  validateDoc,
  validateReferences,
  lintDoc,
  type DeckDoc,
} from "@/lib/domain/model";
import { scene } from "@/lib/domain/scene";
import {
  initialTaskState,
  taskInputSchema,
  questionSchema,
  extractionSchema,
  planSchema,
  type PresentationTask,
  type TaskState,
  type TaskEvent,
  type StoryPlan,
} from "@/lib/domain/task";

type Row = {
  id: string;
  deck_id: string;
  owner: string;
  request_id: string;
  fingerprint: string;
  state: string;
  version: number;
  updated_at: string;
  lease_token: string | null;
  lease_expires_at: number | null;
  run_deadline: number | null;
};
const raw = (id: string) =>
  database()
    .prepare("SELECT * FROM presentation_tasks WHERE id = ?")
    .bind(id)
    .first<Row>();
const baseSchema = z
  .object({
    action: z.string(),
    taskId: z.string().uuid(),
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .passthrough();
const workerActions = new Set([
  "claim",
  "heartbeat",
  "extraction",
  "questions",
  "plan",
  "candidate",
  "fail",
]);
const humanActions = new Set([
  "enqueue",
  "answer",
  "accept_plan",
  "accept_candidate",
  "cancel",
  "revise",
]);
const stateOf = (r: Row): TaskState => JSON.parse(r.state);
async function checked(actor: Actor, id: string) {
  const row = await raw(id);
  if (!row) throw new AppError(404, "Задача недоступна.");
  const deck = await getDeck(actor, row.deck_id);
  return { row, deck };
}
export async function getTask(
  actor: Actor,
  id: string,
): Promise<PresentationTask> {
  let { row, deck } = await checked(actor, id);
  const state = stateOf(row);
  if (
    state.status === "running" &&
    row.lease_expires_at &&
    row.lease_expires_at <= Date.now()
  ) {
    const next = {
      ...state,
      status: "failed" as const,
      error:
        "Связь с исполнителем потеряна. Сохранённые результаты доступны; задачу можно запустить снова.",
    };
    try {
      await commit(
        actor,
        row,
        next,
        "expired",
        "Исполнитель не продлил время выполнения",
        undefined,
        undefined,
        true,
      );
    } catch (e) {
      if (!(e instanceof AppError && e.status === 409)) throw e;
    }
    row = (await raw(id))!;
  }
  return {
    id: row.id,
    deckId: row.deck_id,
    version: row.version,
    updatedAt: row.updated_at,
    state: stateOf(row),
    role: deck.role,
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
  };
}
export async function listTasks(actor: Actor) {
  const rows = await database()
    .prepare(
      "SELECT t.id FROM presentation_tasks t JOIN decks d ON d.id = t.deck_id WHERE d.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.deck_id = d.id AND m.email = ?) ORDER BY t.updated_at DESC LIMIT 100",
    )
    .bind(actor.id, actor.email)
    .all<{ id: string }>();
  const out = [];
  for (const r of rows.results) {
    const t = await getTask(actor, r.id);
    out.push({
      ...t,
      state: {
        input: t.state.input,
        status: t.state.status,
        phase: t.state.phase,
        attempt: t.state.attempt,
        questions: [],
        extractions: [],
      },
    });
  }
  return out;
}
export async function taskEvents(
  actor: Actor,
  id: string,
  after = 0,
): Promise<TaskEvent[]> {
  await checked(actor, id);
  const r = await database()
    .prepare(
      "SELECT sequence, kind, message, created_at AS createdAt FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 200",
    )
    .bind(id, after)
    .all<TaskEvent>();
  return r.results;
}
export async function createTask(actor: Actor, body: unknown) {
  const b = z
      .object({ requestId: z.string().uuid(), input: taskInputSchema })
      .strict()
      .parse(body),
    fp = await fingerprint(b.input);
  const replay = async () => {
    const r = await database()
      .prepare(
        "SELECT id,fingerprint FROM presentation_tasks WHERE owner = ? AND request_id = ?",
      )
      .bind(actor.id, b.requestId)
      .first<{ id: string; fingerprint: string }>();
    if (r && r.fingerprint !== fp)
      throw new AppError(409, "Этот запрос уже использован с другим брифом.");
    return r ? getTask(actor, r.id) : null;
  };
  const previous = await replay();
  if (previous) return previous;
  const brand = await resolveBrand(actor, b.input.brandId),
    id = uid(), initial=initialTaskState(b.input);
  const doc: DeckDoc = {
    schemaVersion: 1,
    id: uid(),
    title: b.input.title,
    design: defaultDesign,
    brand,
    brief: initial.input.brief,
    slides: [
      {
        ...blankSlide("cover"),
        title: b.input.title,
        body: "Рабочий бриф. Слайды появятся после подготовки и принятия результата.",
      },
    ],
  };
  try {
    await createDeck(actor, doc, undefined, {
      id,
      requestId: b.requestId,
      fingerprint: fp,
      state: initial,
    });
  } catch (e) {
    const winner = await replay();
    if (winner) return winner;
    throw e;
  }
  return getTask(actor, id);
}
type Receipt = { requestId: string; fingerprint: string };
async function replay(actor: Actor, taskId: string, receipt: Receipt) {
  const r = await database()
    .prepare(
      "SELECT task_id,fingerprint FROM task_receipts WHERE actor_id = ? AND request_id = ?",
    )
    .bind(actor.id, receipt.requestId)
    .first<{ task_id: string; fingerprint: string }>();
  if (r && (r.task_id !== taskId || r.fingerprint !== receipt.fingerprint))
    throw new AppError(
      409,
      "Идентификатор команды уже использован для другого действия.",
    );
  return r ? getTask(actor, taskId) : null;
}
async function commit(
  actor: Actor,
  row: Row,
  state: TaskState,
  kind: string,
  message: string,
  receipt?: Receipt,
  lease?: { token: string; claim?: boolean },
  expire = false,
) {
  const serialized = JSON.stringify(state);
  if (new TextEncoder().encode(serialized).length > 850_000)
    throw new AppError(413, "Результат задачи слишком большой.");
  const token = uid(),
    now = new Date().toISOString(),
    db = database();
  const running = state.status === "running";
  const predicate = expire
    ? ` AND lease_expires_at <= ${DB_NOW}`
    : lease && !lease.claim
      ? ` AND lease_token = ? AND lease_expires_at > ${DB_NOW} AND run_deadline > ${DB_NOW}`
      : "";
  const permission = expire
    ? ""
    : ` AND EXISTS (SELECT 1 FROM decks d WHERE d.id = presentation_tasks.deck_id AND (d.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.deck_id = d.id AND m.email = ? AND m.role IN (${kind === "accept_plan" ? "'editor','reviewer'" : "'editor'"}))))`;
  const params = [
    serialized,
    token,
    now,
    running ? (lease?.token ?? row.lease_token) : null,
    running
      ? lease?.claim
        ? Date.now() + 90_000
        : row.lease_expires_at
      : null,
    running ? (lease?.claim ? Date.now() + 600_000 : row.run_deadline) : null,
    row.id,
    row.version,
    ...(lease && !lease.claim ? [lease.token] : []),
    ...(expire ? [] : [actor.id, actor.email]),
  ];
  const statements = [
    db
      .prepare(
        "UPDATE presentation_tasks SET state = ?, version = version + 1, mutation_id = ?, updated_at = ?, lease_token = ?, lease_expires_at = ?, run_deadline = ? WHERE id = ? AND version = ?" +
          predicate +
          permission,
      )
      .bind(...params),
    db
      .prepare(
        "INSERT INTO task_events (id, task_id, sequence, kind, message, created_at) SELECT ?, id, version, ?, ?, ? FROM presentation_tasks WHERE id = ? AND mutation_id = ?",
      )
      .bind(uid(), kind, message, now, row.id, token),
  ];
  if (receipt)
    statements.push(
      db
        .prepare(
          "INSERT INTO task_receipts (id, task_id, actor_id, request_id, fingerprint) SELECT ?, id, ?, ?, ? FROM presentation_tasks WHERE id = ? AND mutation_id = ?",
        )
        .bind(
          uid(),
          actor.id,
          receipt.requestId,
          receipt.fingerprint,
          row.id,
          token,
        ),
    );
  try {
    const result = await db.batch(statements);
    if (!result[0].meta.changes)
      throw new AppError(
        409,
        "Задача изменилась или право записи исполнителя истекло. Обновите состояние.",
      );
  } catch (e) {
    if (receipt && (await replay(actor, row.id, receipt))) return;
    throw e;
  }
}
function checkPlan(plan: StoryPlan, state: TaskState) {
  if (
    plan.slides.length !== state.input.targetSlides ||
    new Set(plan.slides.map((s) => s.id)).size !== plan.slides.length
  )
    throw new AppError(
      400,
      "План должен содержать указанное число слайдов с уникальными ID.",
    );
  const sources = new Set(state.snapshot?.sources.map((s) => s.id));
  for (const slide of plan.slides) {
    if (slide.sourceIds.some((id) => !sources.has(id)))
      throw new AppError(400, "План ссылается на недоступный источник.");
    for (const e of slide.evidence)
      if (
        !slide.sourceIds.includes(e.sourceId) ||
        !state.extractions.some(
          (x) =>
            x.sourceId === e.sourceId &&
            x.fragments.some((f) => f.locator === e.locator),
        )
      )
        throw new AppError(
          400,
          "В плане указан несуществующий фрагмент источника.",
        );
  }
}
export async function inspectCandidate(
  actor: Actor,
  id: string,
  value: unknown,
) {
  const { row, deck } = await checked(actor, id),
    state = stateOf(row),
    doc = validateDoc(value);
  const planReady=state.workflow==="draft"?state.planPreparedAt:state.planAcceptedAt;
  if (!state.snapshot || !planReady || !state.plan)
    throw new AppError(409, "Сначала подготовьте план; формальный процесс требует его принятия.");
  if (
    doc.id !== deck.id ||
    (doc.design || "classic-v1") !== (state.snapshot.doc.design || "classic-v1") ||
    JSON.stringify(doc.brand) !== JSON.stringify(state.snapshot.doc.brand) ||
    JSON.stringify(doc.brief) !== JSON.stringify(state.snapshot.doc.brief)
  )
    throw new AppError(
      400,
      "Нельзя подменять документ, бриф, дизайн или закреплённый шаблон.",
    );
  if (
    JSON.stringify(doc.slides.map((s) => s.id)) !==
    JSON.stringify(state.plan.slides.map((s) => s.id))
  )
    throw new AppError(
      400,
      "Слайды должны соответствовать принятому плану и его порядку.",
    );
  if (
    doc.slides.some(
      (slide, i) =>
        JSON.stringify(slide.intent) !==
          JSON.stringify(state.plan!.slides[i].intent) ||
        state.plan!.slides[i].sourceIds.some(
          (id) => !slide.sourceIds.includes(id),
        ),
    )
  )
    throw new AppError(
      400,
      "Сохраните принятые выводы, переходы и ссылки на источники каждого слайда.",
    );
  validateReferences({ ...deck.state, doc });
  const issues = lintDoc(doc),
    overflow = doc.slides
      .filter((s, i) => scene(s, doc.brand, i, doc.slides.length, doc.design).overflow)
      .map((s) => s.id);
  return {
    doc,
    issues,
    overflow,
    valid: !issues.some((i) => i.severity === "error") && !overflow.length,
  };
}
export async function taskSource(
  actor: Actor,
  taskId: string,
  sourceId: string,
) {
  const { row } = await checked(actor, taskId),
    state = stateOf(row),
    source = state.snapshot?.sources.find((s) => s.id === sourceId);
  if (!source) throw new AppError(404, "Источник не входит в снимок задачи.");
  const asset = await database()
    .prepare("SELECT key,sha256 FROM assets WHERE id = ? AND deck_id = ?")
    .bind(sourceId, row.deck_id)
    .first<{ key: string; sha256: string }>();
  if (!asset || asset.sha256 !== source.sha256)
    throw new AppError(404, "Снимок источника недоступен.");
  const file = await bucket().get(asset.key);
  if (!file) throw new AppError(404, "Файл недоступен.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > 5_000_000)
    throw new AppError(413, "Файл слишком большой.");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { ...source, base64: btoa(binary) };
}
export async function taskCommand(
  actor: Actor,
  body: unknown,
  surface: "human" | "agent" = "human",
) {
  const b = baseSchema.parse(body);
  if (!(surface === "agent" ? workerActions : humanActions).has(b.action))
    throw new AppError(403, "Действие недоступно этому интерфейсу.");
  const { row, deck } = await checked(actor, b.taskId);
  allow(
    deck,
    b.action.startsWith("accept_")
      ? ["owner", "editor", "reviewer"]
      : ["owner", "editor"],
  );
  const receipt = {
    requestId: b.requestId,
    fingerprint: await fingerprint({ surface, ...b }),
  };
  const previous = await replay(actor, b.taskId, receipt);
  if (previous)
    return {
      task: previous,
      ...(b.action === "claim" ? { leaseToken: b.requestId } : {}),
    };
  const state = stateOf(row);
  const lease =
    workerActions.has(b.action) && b.action !== "claim"
      ? z.object({ leaseToken: z.string().uuid() }).parse(b).leaseToken
      : undefined;
  if (
    lease &&
    (row.lease_token !== lease ||
      state.status !== "running" ||
      !row.lease_expires_at ||
      row.lease_expires_at <= Date.now() ||
      !row.run_deadline ||
      row.run_deadline <= Date.now())
  )
    throw new AppError(
      409,
      "Исполнитель больше не может записывать результат.",
    );
  if (b.action === "heartbeat") {
    const r = await database()
      .prepare(
        `UPDATE presentation_tasks SET lease_expires_at = MIN(run_deadline, ${DB_NOW} + 90000) WHERE id = ? AND lease_token = ? AND lease_expires_at > ${DB_NOW} AND run_deadline > ${DB_NOW} AND EXISTS (SELECT 1 FROM decks d WHERE d.id = presentation_tasks.deck_id AND (d.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.deck_id = d.id AND m.email = ? AND m.role = 'editor')))`,
      )
      .bind(row.id, lease, actor.id, actor.email)
      .run();
    if (!r.meta.changes) throw new AppError(409, "Право выполнения истекло.");
    return { task: await getTask(actor, row.id) };
  }
  if (b.expectedVersion !== row.version)
    throw new AppError(409, "Задача изменилась. Обновите состояние.");
  const next = structuredClone(state);
  let message = "",
    kind = b.action;
  if (b.action === "enqueue") {
    if (!["draft", "failed", "cancelled"].includes(state.status))
      throw new AppError(409, "Задачу нельзя запустить в этом состоянии.");
    if (state.phase !== "brief" && state.questions.some((q) => !q.answer?.trim()))
      throw new AppError(400, "Ответьте на открытые вопросы.");
    if (state.attempt >= 10)
      throw new AppError(429, "Достигнут лимит 10 попыток для этой задачи.");
    next.snapshot = {
      doc: structuredClone(deck.state.doc),
      sources: structuredClone(deck.state.sources),
      baseRevision: deck.state.revision,
    };
    next.status = state.phase === "brief" ? "awaiting_input" : "queued";
    delete next.error;
    delete next.candidate;
    message = state.phase === "brief" ? "Перед подготовкой уточните три вещи и подтвердите бриф" : "Задача поставлена в очередь";
  } else if (b.action === "claim") {
    if (state.phase === "brief" || (state.briefingRequired && !state.briefConfirmedAt))
      throw new AppError(409, "Сначала человек должен подтвердить бриф.");
    if (state.attempt >= 10)
      throw new AppError(429, "Достигнут лимит попыток задачи.");
    if (state.status !== "queued" || !state.snapshot)
      throw new AppError(409, "Задача уже взята или не готова к выполнению.");
    if (deck.state.revision !== state.snapshot.baseRevision)
      throw new AppError(409, "Материалы изменились. Перезапустите задачу.");
    next.status = "running";
    next.attempt++;
    message =
      state.phase === "story"
        ? "Агент начал работу с материалами и логикой"
        : state.workflow==="draft"?"Агент создаёт черновик по сохранённому плану":"Агент создаёт слайды по принятому плану";
  } else if (b.action === "cancel") {
    if (["completed", "cancelled"].includes(state.status))
      throw new AppError(409, "Задача уже завершена.");
    next.status = "cancelled";
    message = "Задача отменена; поздний результат не будет принят";
  } else if (b.action === "answer") {
    if (state.status !== "awaiting_input")
      throw new AppError(409, "Задача не ожидает ответа.");
    const answers = z
      .array(
        z
          .object({
            id: z.string().uuid(),
            answer: z.string().trim().min(1).max(2000),
            assumed: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12)
      .parse(b.answers);
    if (
      new Set(answers.map((a) => a.id)).size !== answers.length ||
      answers.some(
        (a) => !state.questions.some((q) => q.id === a.id && !q.answer),
      )
    )
      throw new AppError(400, "Неверный список ответов.");
    next.questions = state.questions.map((q) => ({
      ...q,
      ...(answers.find((a) => a.id === q.id)
        ? { answer: answers.find((a) => a.id === q.id)!.answer, assumed: answers.find((a) => a.id === q.id)!.assumed ?? false }
        : {}),
    }));
    if (next.questions.some((q) => !q.answer?.trim()))
      throw new AppError(400, "Ответьте на все открытые вопросы.");
    if (state.phase === "brief") {
      const brief = {...next.input.brief};
      for (const q of next.questions) if (q.field) {
        brief[q.field] = q.answer!;
        brief.origins={...brief.origins,[q.field]:q.assumed?"assumption":"user"};
      }
      next.input.brief = briefSchema.parse(brief);
      next.briefConfirmedAt = new Date().toISOString();
      next.phase = "story";
    }
    next.snapshot = {
      doc: structuredClone(deck.state.doc),
      sources: structuredClone(deck.state.sources),
      baseRevision: deck.state.revision,
    };
    next.status = "queued";
    message = "Ответы сохранены, задача продолжится";
  } else if (b.action === "extraction") {
    const extraction = extractionSchema.parse(b.extraction),
      source = state.snapshot?.sources.find(
        (s) => s.id === extraction.sourceId,
      );
    if (!source || source.sha256 !== extraction.sha256)
      throw new AppError(
        400,
        "Результат разбора не относится к снимку задачи.",
      );
    next.extractions = [
      ...next.extractions.filter((e) => e.sourceId !== extraction.sourceId),
      extraction,
    ];
    message = `Разобран источник: ${source.name}`;
  } else if (b.action === "questions") {
    const questions = z
      .array(questionSchema.omit({ answer: true }))
      .min(1)
      .max(8)
      .parse(b.questions);
    if (
      next.questions.length + questions.length > 24 ||
      new Set([...next.questions, ...questions].map((q) => q.id)).size !==
        next.questions.length + questions.length
    )
      throw new AppError(400, "Слишком много вопросов или повторяющиеся ID.");
    next.questions.push(...questions);
    next.status = "awaiting_input";
    message = "Агенту нужны уточнения";
  } else if (b.action === "plan") {
    if (state.briefingRequired && !state.briefConfirmedAt)
      throw new AppError(409, "Бриф ещё не подтверждён человеком.");
    if (state.phase !== "story") throw new AppError(409, "План уже принят.");
    next.plan = planSchema.parse(b.plan);
    checkPlan(next.plan, next);
    if (deck.state.revision !== state.snapshot?.baseRevision)
      throw new AppError(409, "Документ изменился во время подготовки плана.");
    next.planPreparedAt = new Date().toISOString();
    if(state.workflow==="draft") {
      next.phase="compose";
      next.status="queued";
      message="План сохранён; агент продолжит подготовку черновика";
    } else {
      next.status = "awaiting_review";
      message = "План аргументации готов к проверке";
    }
  } else if (b.action === "accept_plan") {
    if (
      state.status !== "awaiting_review" ||
      state.phase !== "story" ||
      !state.plan
    )
      throw new AppError(409, "Нет плана для принятия.");
    if (deck.state.revision !== state.snapshot?.baseRevision)
      throw new AppError(409, "Материалы изменились. Нужен обновлённый план.");
    next.planAcceptedAt = new Date().toISOString();
    next.phase = "compose";
    next.status = "queued";
    message = "План принят, слайды поставлены в работу";
  } else if (b.action === "revise") {
    if (state.status !== "awaiting_review")
      throw new AppError(409, "Нет результата на проверке.");
    const text = z.string().trim().min(3).max(2000).parse(b.feedback);
    next.input.instruction = (
      state.input.instruction +
      "\nУточнение: " +
      text
    ).slice(-4000);
    next.status = "draft";
    delete next.candidate;
    message = "Замечание сохранено; запустите доработку";
  } else if (b.action === "candidate") {
    if (state.phase !== "compose")
      throw new AppError(409, "Сначала нужен принятый план.");
    const result = await inspectCandidate(actor, row.id, b.doc);
    if (!result.valid)
      throw new AppError(
        400,
        JSON.stringify({ issues: result.issues, overflow: result.overflow }),
      );
    if (deck.state.revision !== state.snapshot?.baseRevision)
      throw new AppError(
        409,
        "Документ изменился; результат не может быть применён.",
      );
    next.candidate = result.doc;
    next.critique = z.string().min(1).max(4000).parse(b.critique);
    next.status = "awaiting_review";
    message = "Слайды и отчёт проверки готовы к просмотру";
  } else if (b.action === "fail") {
    next.error = z.string().min(1).max(700).parse(b.message);
    next.status = "failed";
    message = next.error;
  } else if (b.action === "accept_candidate") {
    if (
      state.status !== "awaiting_review" ||
      !state.candidate ||
      state.phase !== "compose"
    )
      throw new AppError(409, "Нет слайдов для принятия.");
    if (deck.state.revision !== state.snapshot?.baseRevision)
      throw new AppError(
        409,
        "Презентация изменилась. Нужен обновлённый результат.",
      );
    const checkedResult = await inspectCandidate(
      actor,
      row.id,
      state.candidate,
    );
    if (!checkedResult.valid)
      throw new AppError(400, "Проверки композиции не пройдены.");
    const content = structuredClone(deck.state);
    content.doc = state.candidate;
    changedContent(content);
    next.status = "completed";
    try {
      await saveDeck(actor, deck, content, "task.accept", {
        task: { id: row.id, version: row.version, state: next, ...receipt },
      });
    } catch (e) {
      if (!(await replay(actor, row.id, receipt))) throw e;
    }
    return { task: await getTask(actor, row.id) };
  }
  if (next.snapshot && (next.briefConfirmedAt || next.workflow==="draft")) next.snapshot.doc.brief = {...next.input.brief};
  await commit(
    actor,
    row,
    next,
    kind,
    message,
    receipt,
    b.action === "claim"
      ? { token: b.requestId, claim: true }
      : lease
        ? { token: lease }
        : undefined,
  );
  return {
    task: await getTask(actor, row.id),
    ...(b.action === "claim" ? { leaseToken: b.requestId } : {}),
  };
}
