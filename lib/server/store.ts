import {
  receiptStatement,
  DB_NOW,
  type ReceiptIntent,
  type RunFence,
} from "./idempotency";
import { database, bucket } from "@/db";
import type { MaterialInput } from "@/lib/domain/material-input";
import type { TaskState } from "@/lib/domain/task";
import { AppError, type Actor } from "./auth";
import {
  type Deck,
  type State,
  type DeckDoc,
  type Brand,
  type Release,
  type Audit,
  initialState,
  validateDoc,
  validateReferences,
  defaultBrand,
  editorialBrand,
  uid,
  brandSchema,
  hasContrast,
} from "@/lib/domain/model";
type Row = {
  id: string;
  owner: string;
  version: number;
  state: string;
  updated_at: string;
};
export async function getDeck(actor: Actor, id: string): Promise<Deck> {
  const row = await database()
    .prepare(
      "SELECT id, owner, version, state, updated_at FROM decks WHERE id = ?",
    )
    .bind(id)
    .first<Row>();
  if (!row) throw new AppError(404, "Презентация недоступна.");
  let role: Deck["role"] = "owner";
  if (row.owner !== actor.id) {
    const grant = await database()
      .prepare("SELECT role FROM memberships WHERE deck_id = ? AND email = ?")
      .bind(id, actor.email)
      .first<{ role: Deck["role"] }>();
    if (!grant) throw new AppError(404, "Презентация недоступна.");
    role = grant.role;
  }
  return {
    id: row.id,
    owner: row.owner,
    version: row.version,
    updatedAt: row.updated_at,
    state: JSON.parse(row.state),
    role,
  };
}
export function allow(deck: Deck, roles: Deck["role"][]) {
  if (!roles.includes(deck.role))
    throw new AppError(403, "У вашей роли нет права выполнить это действие.");
}
export async function listDecks(actor: Actor) {
  const rows = await database()
    .prepare(
      "SELECT d.id FROM decks d WHERE d.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.deck_id = d.id AND m.email = ?) ORDER BY d.updated_at DESC LIMIT 100",
    )
    .bind(actor.id, actor.email)
    .all<{ id: string }>();
  return Promise.all(rows.results.map((r) => getDeck(actor, r.id)));
}
export async function getBrands(actor: Actor): Promise<Brand[]> {
  const rows = await database()
    .prepare(
      "SELECT data FROM brands WHERE owner = ? ORDER BY created_at DESC LIMIT 60",
    )
    .bind(actor.id)
    .all<{ data: string }>();
  return [
    defaultBrand,
    editorialBrand,
    ...rows.results.map((r) => JSON.parse(r.data)),
  ];
}
export async function resolveBrand(
  actor: Actor,
  brandId: string,
): Promise<Brand> {
  const b = (await getBrands(actor)).find((b) => b.id === brandId);
  if (!b) throw new AppError(404, "Шаблон недоступен.");
  return structuredClone(b);
}
export async function createDeck(
  actor: Actor,
  input: DeckDoc,
  receipt?: ReceiptIntent,
  task?: {
    id: string;
    requestId: string;
    fingerprint: string;
    state: TaskState;
  },
  materials: MaterialInput[] = [],
): Promise<Deck> {
  const doc = validateDoc(input),
    originalId = doc.id;
  doc.id = uid();
  doc.brand = await resolveBrand(actor, doc.brand.id);
  const state = initialState(doc);
  const now = new Date().toISOString(),
    token = uid(),
    db = database();
  const used = Array.from(
    new Set(
      doc.slides.flatMap((s) => [
        ...s.sourceIds,
        ...s.metrics.flatMap((m) => (m.sourceId ? [m.sourceId] : [])),
        ...(s.assetId ? [s.assetId] : []),
        ...(s.canvas?.flatMap(e=>e.kind==="image"?[e.assetId]:(e.kind==="chart"||e.kind==="table")&&e.data.sourceId?[e.data.sourceId]:[])??[]),
        ...(s.table?.sourceId ? [s.table.sourceId] : []),
      ]),
    ),
  );
  const copies: { previous: string; id: string }[] = [];
  const uploads: { id:string; key:string; source:State["sources"][number]; bytes:Uint8Array }[]=[];
  if(materials.length){
    const mapping=new Map<string,string>();
    let size=0;
    for(const material of materials){
      const bytes=Uint8Array.from(atob(material.base64),c=>c.charCodeAt(0));
      size+=bytes.length;
      if(bytes.length>600000 || size>2000000)throw new AppError(413,"Материалы превышают лимит импорта.");
      if(material.contentType==="image/png" && ![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))throw new AppError(400,"Некорректный PNG.");
      if(material.contentType==="image/jpeg" && !(bytes[0]===255&&bytes[1]===216&&bytes[2]===255))throw new AppError(400,"Некорректный JPEG.");
      const sha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),v=>v.toString(16).padStart(2,"0")).join("");
      const id=uid(),image=material.contentType.startsWith("image/");
      const source={id,name:material.name,contentType:material.contentType,kind:image?"image" as const:"text" as const,sha256,createdAt:now,excerpt:image?"":new TextDecoder("utf-8",{fatal:true}).decode(bytes).slice(0,12000)};
      mapping.set(material.id,id);state.sources.push(source);
      uploads.push({id,key:`${actor.id}/${doc.id}/${id}`,source,bytes});
    }
    for(const material of materials)if(material.image){
      const source=state.sources.find(s=>s.id===mapping.get(material.id))!;
      const target=material.image.normalizedSourceId??material.image.originalSourceId;
      if(target&&!mapping.has(target))throw new AppError(400,"Отсутствует обработанный вариант изображения.");
      source.image={...material.image,...(material.image.normalizedSourceId?{normalizedSourceId:mapping.get(target!)!}:material.image.originalSourceId?{originalSourceId:mapping.get(target!)!}:{})};
    }
    if(used.some(id=>!mapping.has(id)))throw new AppError(400,"В переносе отсутствуют материалы слайдов.");
    for(const s of doc.slides){
      s.sourceIds=s.sourceIds.map(id=>mapping.get(id)!);
      if(s.assetId)s.assetId=mapping.get(s.assetId);
      for(const e of s.canvas??[]){if(e.kind==="image")e.assetId=mapping.get(e.assetId)!;else if((e.kind==="chart"||e.kind==="table")&&e.data.sourceId)e.data.sourceId=mapping.get(e.data.sourceId)!;}
      if(s.table?.sourceId)s.table.sourceId=mapping.get(s.table.sourceId);
      for(const metric of s.metrics)if(metric.sourceId)metric.sourceId=mapping.get(metric.sourceId);
    }
  } else if (used.length) {
    const original = await getDeck(actor, originalId);
    const mapping = new Map<string, string>();
    // Copy both members of a normalized/original pair when either is used.
    let extended=true;while(extended){extended=false;for(const source of original.state.sources){
      const target=source.image?.normalizedSourceId??source.image?.originalSourceId;if(target&&(used.includes(source.id)||used.includes(target)))for(const id of [source.id,target])if(!used.includes(id)){used.push(id);extended=true;}
    }}
    for (const previous of used) {
      const src = original.state.sources.find((s) => s.id === previous);
      if (!src)
        throw new AppError(
          400,
          "Источник отсутствует в исходной презентации. При переносе между сервисами загрузите материалы заново.",
        );
      const id = uid();
      mapping.set(previous, id);
      copies.push({ previous, id });
      state.sources.push({ ...src, id });
    }
    for(const source of state.sources)if(source.image)source.image={...source.image,...(source.image.normalizedSourceId?{normalizedSourceId:mapping.get(source.image.normalizedSourceId)!}:{}),...(source.image.originalSourceId?{originalSourceId:mapping.get(source.image.originalSourceId)!}:{})};
    for (const slide of doc.slides) {
      for(const e of slide.canvas??[]){if(e.kind==="image")e.assetId=mapping.get(e.assetId)!;else if((e.kind==="chart"||e.kind==="table")&&e.data.sourceId)e.data.sourceId=mapping.get(e.data.sourceId)!;}
      slide.sourceIds = slide.sourceIds.map((id) => mapping.get(id)!);
      if (slide.assetId) slide.assetId = mapping.get(slide.assetId);
      if (slide.table?.sourceId) slide.table.sourceId = mapping.get(slide.table.sourceId);
      for (const m of slide.metrics)
        if (m.sourceId) m.sourceId = mapping.get(m.sourceId);
    }
  }
  validateReferences(state);
  if(new TextEncoder().encode(JSON.stringify(state)).length>900000)throw new AppError(413,"Презентация слишком большая.");
  const written:string[]=[];
  try {
  for(const u of uploads){await bucket().put(u.key,u.bytes,{httpMetadata:{contentType:u.source.contentType}});written.push(u.key);}
  await db.batch([
    db
      .prepare(
        "INSERT INTO decks (id, owner, title, state, version, mutation_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
      )
      .bind(
        doc.id,
        actor.id,
        doc.title,
        JSON.stringify(state),
        token,
        now,
        now,
      ),
    db
      .prepare(
        "INSERT INTO revisions (id, deck_id, revision, doc, created_at, actor) VALUES (?, ?, 1, ?, ?, ?)",
      )
      .bind(uid(), doc.id, JSON.stringify(doc), now, actor.email),
    db
      .prepare(
        "INSERT INTO events (id, deck_id, revision, action, actor, created_at) VALUES (?, ?, 1, ?, ?, ?)",
      )
      .bind(uid(), doc.id, "create", actor.email, now),
    ...(receipt ? [receiptStatement(receipt, doc.id, 1, token, now)] : []),
    ...(task
      ? [
          db
            .prepare(
              "INSERT INTO presentation_tasks (id, deck_id, owner, request_id, fingerprint, state, version, mutation_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
            )
            .bind(
              task.id,
              doc.id,
              actor.id,
              task.requestId,
              task.fingerprint,
              JSON.stringify(task.state),
              token,
              now,
            ),
          db
            .prepare(
              "INSERT INTO task_events (id, task_id, sequence, kind, message, created_at) VALUES (?, ?, 1, 'created', 'Бриф сохранён', ?)",
            )
            .bind(uid(), task.id, now),
        ]
      : []),
    ...copies.map((c) =>
      db
        .prepare(
          "INSERT INTO assets (id, deck_id, owner, key, name, kind, sha256, content_type, excerpt, created_at) SELECT ?, ?, ?, key, name, kind, sha256, content_type, excerpt, created_at FROM assets WHERE id = ? AND deck_id = ?",
        )
        .bind(c.id, doc.id, actor.id, c.previous, originalId),
    ),
    ...uploads.map(u=>db.prepare("INSERT INTO assets (id, deck_id, owner, key, name, kind, sha256, content_type, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(u.id,doc.id,actor.id,u.key,u.source.name,u.source.kind,u.source.sha256,u.source.contentType,u.source.excerpt,now)),
  ]);
  } catch(error) {
    await Promise.allSettled(written.map(key=>bucket().delete(key)));
    throw error;
  }
  return {
    id: doc.id,
    owner: actor.id,
    version: 1,
    updatedAt: now,
    state,
    role: "owner",
  };
}
export async function saveDeck(
  actor: Actor,
  old: Deck,
  state: State,
  action: string,
  opts: {
    release?: boolean;
    share?: boolean;
    receipt?: ReceiptIntent;
    run?: RunFence;
    task?: {
      id: string;
      version: number;
      state: TaskState;
      requestId: string;
      fingerprint: string;
    };
  } = {},
): Promise<Deck> {
  validateDoc(state.doc);
  validateReferences(state);
  const serialized = JSON.stringify(state);
  if (new TextEncoder().encode(serialized).length > 900_000)
    throw new AppError(
      413,
      "Документ слишком большой. Закройте старые предложения или разделите презентацию.",
    );
  const db = database(),
    token = uid(),
    now = new Date().toISOString(),
    commands = [
      db
        .prepare(
          "UPDATE decks SET state = ?, title = ?, version = version + 1, mutation_id = ?, updated_at = ? WHERE id = ? AND version = ?" +
            (opts.task
              ? " AND EXISTS (SELECT 1 FROM presentation_tasks WHERE id = ? AND deck_id = decks.id AND version = ?)"
              : "") +
            (opts.run
              ? ` AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND actor_id = ? AND deck_id = decks.id AND status = 'running' AND deadline_at > ${DB_NOW})`
              : ""),
        )
        .bind(
          serialized,
          state.doc.title,
          token,
          now,
          old.id,
          old.version,
          ...(opts.task ? [opts.task.id, opts.task.version] : []),
          ...(opts.run ? [opts.run.id, actor.id] : []),
        ),
      db
        .prepare(
          "INSERT INTO events (id, deck_id, revision, action, actor, created_at) SELECT ?, id, ?, ?, ?, ? FROM decks WHERE id = ? AND mutation_id = ?",
        )
        .bind(uid(), state.revision, action, actor.email, now, old.id, token),
    ];
  if (opts.task)
    commands.push(
      db
        .prepare(
          "UPDATE presentation_tasks SET state = ?, version = version + 1, mutation_id = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL, run_deadline = NULL WHERE id = ? AND version = ? AND EXISTS (SELECT 1 FROM decks WHERE id = ? AND mutation_id = ?)",
        )
        .bind(
          JSON.stringify(opts.task.state),
          token,
          now,
          opts.task.id,
          opts.task.version,
          old.id,
          token,
        ),
      db
        .prepare(
          "INSERT INTO task_events (id, task_id, sequence, kind, message, created_at) SELECT ?, id, version, 'candidate.accepted', 'Слайды приняты в презентацию', ? FROM presentation_tasks WHERE id = ? AND mutation_id = ?",
        )
        .bind(uid(), now, opts.task.id, token),
      db
        .prepare(
          "INSERT INTO task_receipts (id, task_id, actor_id, request_id, fingerprint) SELECT ?, id, ?, ?, ? FROM presentation_tasks WHERE id = ? AND mutation_id = ?",
        )
        .bind(
          uid(),
          actor.id,
          opts.task.requestId,
          opts.task.fingerprint,
          opts.task.id,
          token,
        ),
    );
  if (state.revision !== old.state.revision)
    commands.push(
      db
        .prepare(
          "INSERT INTO revisions (id, deck_id, revision, doc, created_at, actor) SELECT ?, id, ?, ?, ?, ? FROM decks WHERE id = ? AND mutation_id = ?",
        )
        .bind(
          uid(),
          state.revision,
          JSON.stringify(state.doc),
          now,
          actor.email,
          old.id,
          token,
        ),
    );
  if (opts.release)
    commands.push(
      db
        .prepare(
          "INSERT INTO releases (id, deck_id, revision, title, doc, created_at, created_by) SELECT ?, id, ?, ?, ?, ?, ? FROM decks WHERE id = ? AND mutation_id = ?",
        )
        .bind(
          uid(),
          state.revision,
          state.doc.title,
          JSON.stringify(state.doc),
          now,
          actor.email,
          old.id,
          token,
        ),
    );
  if (opts.share) {
    commands.push(
      db
        .prepare(
          "DELETE FROM memberships WHERE deck_id = ? AND EXISTS (SELECT 1 FROM decks WHERE id = ? AND mutation_id = ?)",
        )
        .bind(old.id, old.id, token),
    );
    for (const g of state.grants)
      commands.push(
        db
          .prepare(
            "INSERT INTO memberships (id, deck_id, email, role) SELECT ?, id, ?, ? FROM decks WHERE id = ? AND mutation_id = ?",
          )
          .bind(uid(), g.email, g.role, old.id, token),
      );
  }
  if (opts.receipt)
    commands.push(
      receiptStatement(opts.receipt, old.id, state.revision, token, now),
    );
  if (opts.run)
    commands.push(
      db
        .prepare(
          "UPDATE agent_runs SET status = 'succeeded', proposal_id = ?, total_tokens = ?, updated_at = ?, transition_id = ? WHERE id = ? AND status = 'running' AND EXISTS (SELECT 1 FROM decks WHERE id = ? AND mutation_id = ?)",
        )
        .bind(
          opts.run.proposalId ?? null,
          opts.run.totalTokens,
          now,
          token,
          opts.run.id,
          old.id,
          token,
        ),
    );
  const result = await db.batch(commands);
  if (result[0].meta.changes !== 1)
    throw new AppError(
      409,
      "Презентация изменилась в другой вкладке. Обновите данные и повторите действие.",
    );
  return {
    id: old.id,
    owner: old.owner,
    version: old.version + 1,
    updatedAt: now,
    state,
    role: old.role,
  };
}
export async function activity(actor: Actor, id: string): Promise<Audit[]> {
  await getDeck(actor, id);
  const r = await database()
    .prepare(
      "SELECT id, action, actor, created_at AS createdAt, revision FROM events WHERE deck_id = ? ORDER BY created_at DESC LIMIT 80",
    )
    .bind(id)
    .all<Audit>();
  return r.results;
}
export async function history(actor: Actor, id: string) {
  await getDeck(actor, id);
  return (
    await database()
      .prepare(
        "SELECT revision, created_at AS createdAt, actor FROM revisions WHERE deck_id = ? ORDER BY revision DESC LIMIT 50",
      )
      .bind(id)
      .all()
  ).results;
}
export async function historicalDoc(
  actor: Actor,
  id: string,
  revision: number,
): Promise<DeckDoc> {
  await getDeck(actor, id);
  const r = await database()
    .prepare("SELECT doc FROM revisions WHERE deck_id = ? AND revision = ?")
    .bind(id, revision)
    .first<{ doc: string }>();
  if (!r) throw new AppError(404, "Версия недоступна.");
  return JSON.parse(r.doc);
}
export async function getReleases(
  actor: Actor,
  id: string,
): Promise<Release[]> {
  await getDeck(actor, id);
  const r = await database()
    .prepare(
      "SELECT id, deck_id AS deckId, revision, title, doc, created_at AS createdAt, created_by AS createdBy FROM releases WHERE deck_id = ? ORDER BY created_at DESC",
    )
    .bind(id)
    .all<Omit<Release, "doc"> & { doc: string }>();
  return r.results.map((r) => ({ ...r, doc: JSON.parse(r.doc) }));
}
export async function saveBrand(actor: Actor, input: unknown) {
  const data = brandSchema.parse(input);
  if (data.status === "certified" && !hasContrast(data))
    throw new AppError(
      400,
      "Контраст цветов недостаточен: нужен минимум 4,5:1 для текста и белого на основном цвете.",
    );
  const brand = { ...data, id: uid() };
  await database()
    .prepare(
      "INSERT INTO brands (id, owner, data, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(brand.id, actor.id, JSON.stringify(brand), new Date().toISOString())
    .run();
  return brand;
}
