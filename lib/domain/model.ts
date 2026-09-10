import {prepareBriefReview,acceptBriefReview,type BriefReviewChange} from './brief-review';
import { z } from "zod";
import { imageFrameSchema } from './image-frame';
import {imageMetadataSchema} from './image-source';
import { remainingSlide, pendingObjects, mergeObjects, recordObjectDecisions } from "./object-review";
import { canonicalJson } from "./canonical-json";
import { briefSchema, intentSchema } from "./narrative";
import { designSchema, defaultDesign } from "./design";
export const uid = () => crypto.randomUUID();
const id = z.string().min(1).max(80);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const brandSchema = z
  .object({
    id,
    name: z.string().min(1).max(80),
    version: z.number().int().positive(),
    primary: color,
    ink: color,
    paper: color,
    accent: color,
    company: z.string().max(70),
    status: z.enum(["draft", "certified"]),
  })
  .strict();
export type Brand = z.infer<typeof brandSchema>;
const elementBox = {
  id, x: z.number().finite().min(0).max(1600), y: z.number().finite().min(0).max(900),
  w: z.number().finite().positive().max(1600), h: z.number().finite().positive().max(900),
  locked: z.boolean().optional(),
};
const dataStyleSchema=z.object({design:designSchema,brand:brandSchema,layoutVersion:z.literal('focus-v3-data-2').optional()}).strict();
const dataColumn=z.object({id,label:z.string().trim().min(1).max(60),role:z.enum(["key","text","meta","number"]),valueType:z.enum(["text","number"]),unit:z.string().max(20)}).strict();
export const chartDataSchema=z.object({seriesId:id,unit:z.string().max(20),sourceId:id.optional(),
  rows:z.array(z.object({id,label:z.string().max(50),value:z.number().finite()}).strict()).min(1).max(8),
}).strict().refine(d=>new Set(d.rows.map(r=>r.id)).size===d.rows.length,"Строки диаграммы должны иметь уникальные ID.");
export const tableDataSchema=z.object({sourceId:id.optional(),columns:z.array(dataColumn).min(2).max(4),
  rows:z.array(z.object({id,cells:z.record(z.union([z.string().max(160),z.number().finite()]))}).strict()).min(1).max(6),
}).strict().superRefine((d,ctx)=>{
  if(new Set(d.columns.map(c=>c.id)).size!==d.columns.length||new Set(d.rows.map(r=>r.id)).size!==d.rows.length)
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"Строки и колонки должны иметь уникальные ID."});
  for(const r of d.rows){
    if(Object.keys(r.cells).length!==d.columns.length||d.columns.some(c=>!Object.hasOwn(r.cells,c.id)))
      ctx.addIssue({code:z.ZodIssueCode.custom,message:"Ячейки должны соответствовать колонкам."});
    for(const c of d.columns)if(c.valueType==="number"&&typeof r.cells[c.id]!=="number")
      ctx.addIssue({code:z.ZodIssueCode.custom,message:"Числовая колонка требует числа в каждой строке."});
  }
});
export const canvasElementSchema = z.discriminatedUnion("kind", [
  z.object({...elementBox, kind:z.literal("text"), text:z.string().max(2400), color,
    size:z.number().finite().min(8).max(240), bold:z.boolean(), font:z.enum(["sans","mono"]).optional(),
    tracking:z.number().finite().min(-0.1).max(0.5).optional(), lineHeight:z.number().finite().min(0.8).max(3),
    sourceField:z.string().max(100).optional(),
    binding:z.literal("focus-v3-pagination").optional(),
  }).strict(),
  z.object({...elementBox, kind:z.literal("rect"), color,binding:z.literal("focus-v3-pagination").optional()}).strict(),
  z.object({...elementBox,kind:z.literal("chart"),data:chartDataSchema,style:dataStyleSchema}).strict(),
  z.object({...elementBox,kind:z.literal("table"),data:tableDataSchema,style:dataStyleSchema}).strict(),
  z.object({...elementBox, kind:z.literal("image"), assetId:id, frame:imageFrameSchema.optional()}).strict(),
]);
export type CanvasElement = z.infer<typeof canvasElementSchema>;
export const canvasSchema = z.array(canvasElementSchema).min(1).max(240)
  .refine(a=>new Set(a.map(e=>e.id)).size===a.length,"Идентификаторы объектов должны быть уникальны.");
export const layouts = [
  "cover",
  "content",
  "split",
  "metrics",
  "chart",
  "image",
  "closing",
  "statement",
  "steps",
  "table",
] as const;
export const layoutNames: Record<(typeof layouts)[number], string> = {
  cover: "Титульный",
  content: "Тезисы",
  split: "Две колонки",
  metrics: "Показатели",
  chart: "Диаграмма",
  image: "Изображение",
  closing: "Следующий шаг",
  statement: "Ключевой вывод",
  steps: "План действий",
  table: "Таблица сравнения",
};
export const metricSchema = z
  .object({
    id,
    label: z.string().min(1).max(70),
    value: z.number().finite(),
    unit: z.string().max(20),
    sourceId: id.optional(),
  })
  .strict();
const comparisonPair = z.object({ label: z.string().max(40), text: z.string().max(200) }).strict();
export const comparisonSchema = z.object({
  mode: z.enum(["neutral", "correction"]).optional(),
  prompt: comparisonPair.optional(),
  before: comparisonPair,
  after: comparisonPair,
  status: z.string().max(80).optional(),
}).strict();
export const tableSchema = z.object({
  columns: z.array(z.string().trim().min(1).max(60)).min(2).max(4),
  rows: z.array(z.array(z.string().max(160)).min(2).max(4)).min(1).max(6),
  sourceId: id.optional(),
  columnRoles: z.array(z.enum(["key", "text", "meta", "number"])).min(2).max(4).optional(),
}).strict().refine(t => t.rows.every(r => r.length === t.columns.length), "Каждая строка должна соответствовать колонкам")
  .refine(t => !t.columnRoles || t.columnRoles.length === t.columns.length, "Роли колонок должны соответствовать колонкам");
export const slideSchema = z
  .object({
    id,
    layout: z.enum(layouts),
    title: z.string().max(180),
    eyebrow: z.string().max(80),
    body: z.string().max(2400),
    notes: z.string().max(4000),
    metrics: z.array(metricSchema).max(4),
    chart: z
      .array(
        z.object({ label: z.string().max(50), value: z.number().finite() }),
      )
      .max(8),
    chartUnit: z.string().max(20),
    sourceIds: z.array(id).max(12),
    assetId: id.optional(),
    table: tableSchema.optional(),
    comparison: comparisonSchema.optional(),
    intent: intentSchema.optional(),
    /** Canonical objects after direct editing. Semantic fields retain the original template data. */
    canvas: canvasSchema.optional(),
  })
  .strict();
export const docSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    title: z.string().min(1).max(140),
    brand: brandSchema,
    design: designSchema.optional(),
    brief: briefSchema.optional(),
    slides: z.array(slideSchema).min(1).max(40),
  })
  .strict();
export type Slide = z.infer<typeof slideSchema>;
export type DeckDoc = z.infer<typeof docSchema>;
export type Source = {
  id: string;
  name: string;
  kind: "text" | "image" | "document";
  sha256: string;
  createdAt: string;
  contentType: string;
  excerpt: string;
  extraction?: import('./source-extraction').SourceExtraction;
  image?:z.infer<typeof imageMetadataSchema>;
};
export type Proposal = {
  briefChanges?: (BriefReviewChange & {id:string;status:"pending"|"accepted"|"rejected"})[];
  draftCandidate?: {before: DeckDoc; after: DeckDoc};
  visibility?: "shared";
  authorPrincipalId?: string;
  delegationId?: string;
  id: string;
  title: string;
  author: string;
  baseRevision: number;
  feedbackIds?: string[];
  createdAt: string;
  changes: {
    id: string;
    slideId: string;
    before: Slide;
    after: Slide;
    status: "pending" | "accepted" | "rejected";
    sourceDependencies?: { id: string; contentHash: string }[];
    objectDecisions?: { elementId: string; status: "accepted" | "rejected" }[];
  }[];
  status: "pending" | "closed";
};
export type Comment = {
  visibility?: "shared";
  delegationId?: string;
  statusVersion?: number;
  statusHistory?: {delegationId?:string;version:number;resolved:boolean;actorPrincipalId:string;author:string;createdAt:string}[];
  authorPrincipalId?: string;
  revision?: number;
  id: string;
  slideId: string;
  text: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  replyTo?: string;
  proposalId?: string;
  anchor?: { elementId: string; quote: string; revision: number };
};
export type Grant = { email: string; role: "viewer" | "editor" | "reviewer" };
export type State = {
  doc: DeckDoc;
  revision: number;
  proposals: Proposal[];
  comments: Comment[];
  sources: Source[];
  grants: Grant[];
  approvedRevision: number | null;
  approvedBy: string | null;
};
export type Deck = {
  id: string;
  owner: string;
  version: number;
  updatedAt: string;
  state: State;
  role: "owner" | "editor" | "reviewer" | "viewer";
};
export type Release = {
  id: string;
  deckId: string;
  revision: number;
  title: string;
  createdAt: string;
  createdBy: string;
  doc: DeckDoc;
};
export type Audit = {
  id: string;
  action: string;
  actor: string;
  createdAt: string;
  revision: number;
};
export const defaultBrand: Brand = {
  id: "lanka-default",
  name: "Lanka / Corporate",
  version: 1,
  primary: "#444BE8",
  ink: "#20243B",
  paper: "#FFFFFF",
  accent: "#A9AEFF",
  company: "LANKA",
  status: "certified",
};
export const editorialBrand: Brand = {
  id: "lanka-editorial",
  name: "Editorial / Graphite",
  version: 1,
  primary: "#125B50",
  ink: "#172E2A",
  paper: "#F6F8F5",
  accent: "#C0E4B7",
  company: "LANKA",
  status: "certified",
};
export function blankSlide(layout: Slide["layout"] = "content"): Slide {
  return {
    id: uid(),
    layout,
    title: "Новый слайд",
    eyebrow: "",
    body: "",
    notes: "",
    metrics: [],
    chart: [],
    chartUnit: "",
    sourceIds: [],
  };
}
export function initialState(doc: DeckDoc): State {
  return {
    doc,
    revision: 1,
    proposals: [],
    comments: [],
    sources: [],
    grants: [],
    approvedRevision: null,
    approvedBy: null,
  };
}
export function validateDoc(value: unknown): DeckDoc {
  const doc = docSchema.parse(value);
  if (new Set(doc.slides.map((s) => s.id)).size !== doc.slides.length)
    throw new Error("Идентификаторы слайдов должны быть уникальны.");
  if (
    doc.slides.some(
      (s) => new Set(s.metrics.map((m) => m.id)).size !== s.metrics.length,
    )
  )
    throw new Error("Идентификаторы показателей должны быть уникальны.");
  if(doc.slides.some(s=>s.canvas?.some(e=>e.kind==="text" && (doc.design==="focus-v3" ? !e.font : !!e.font))))
    throw new Error("Шрифты объектов должны соответствовать дизайну презентации: Plex для Focus 3, DejaVu для остальных.");
  if(doc.slides.some(s=>s.canvas?.some(e=>(e.kind==='chart'||e.kind==='table')&&e.style.design!==(doc.design??"classic-v1"))))
    throw new Error("Дизайн объекта данных должен соответствовать презентации.");
  return doc;
}
export function validateReferences(state: State) {
  const sources = new Map(state.sources.map((s) => [s.id, s]));
  for(const source of state.sources)if(source.image){
    imageMetadataSchema.parse(source.image);
    const target=source.image.normalizedSourceId,normalized=target?sources.get(target):null,original=source.image.originalSourceId;
    if(original&&(original===source.id||sources.get(original)?.kind!=="image"||target))throw Error("Некорректная связь исходного изображения.");
    if(source.kind!=="image"||target&&(target===source.id||normalized?.kind!=="image"||normalized.image?.normalizedSourceId))throw Error("Некорректная связь вариантов изображения.");
  }
  for (const s of state.doc.slides) {
    for (const source of [
      ...s.sourceIds,
      ...s.metrics.flatMap((m) => (m.sourceId ? [m.sourceId] : [])),
      ...(s.table?.sourceId ? [s.table.sourceId] : []),
      ...(s.canvas??[]).flatMap(e=>(e.kind==='chart'||e.kind==='table')&&e.data.sourceId?[e.data.sourceId]:[]),
    ])
      if (!sources.has(source))
        throw new Error("Ссылка на недоступный источник.");
    if (s.assetId && sources.get(s.assetId)?.kind !== "image")
      throw new Error("Изображение недоступно.");
    if (s.canvas?.some(e=>e.kind==="image" && sources.get(e.assetId)?.kind!=="image"))
      throw new Error("Изображение объекта недоступно.");
  }
}
export type Lint = {
  code: string;
  slideId: string;
  severity: "error" | "warning";
  message: string;
};
export function lintDoc(doc: DeckDoc): Lint[] {
  const out: Lint[] = [];
  const add = (
    s: Slide,
    code: string,
    severity: Lint["severity"],
    message: string,
  ) => out.push({ code, slideId: s.id, severity, message });
  for (const s of doc.slides) {
    if (s.canvas) {
      for(const e of s.canvas)if((e.kind==='chart'||e.kind==='table')&&!e.data.sourceId)
        add(s,'data-source','warning','У таблицы или диаграммы не указан источник данных.');
      if (!s.canvas.some(e=>e.kind==="image" || e.kind==="chart" || e.kind==="table" || e.kind==="text" && e.text.trim()))
        add(s,"empty-canvas","warning","На слайде нет текста или изображений.");
      continue;
    }
    if (doc.design === "focus-v3") {
      if (s.layout === "split" && !s.comparison) {
        const parts = s.body.split(/\n\s*\n/).filter(p => p.trim());
        if (parts.length !== 2 || parts.some(p => !p.includes("\n")))
          add(s, "split-shape", "error", "Для сравнения заполните comparison (было / предложено) или ровно два блока «подпись⏎текст».");
      }
      if (s.layout === "split" && s.comparison && /[«"]/.test(s.title))
        add(s, "split-title-quote", "warning", "Заголовок сравнения должен быть выводом, а не цитатой: цитата уходит в comparison.prompt.");
      if (s.title.includes("\n") && !["cover", "statement", "closing"].includes(s.layout))
        add(s, "title-hard-break", "warning", "Ручной перенос в заголовке: Focus 3 переносит и балансирует строки сам.");
    }
    if (!s.title.trim()) add(s, "empty-title", "error", "Добавьте заголовок.");
    if (s.title.length > 100)
      add(s, "long-title", "warning", "Длинный заголовок: проверьте переносы.");
    if (s.body.length > 900)
      add(
        s,
        "dense-body",
        "warning",
        "На слайде много текста. Разделите его на несколько слайдов.",
      );
    if (s.layout === "metrics" && s.metrics.length === 0)
      add(s, "empty-metrics", "error", "Добавьте хотя бы один показатель.");
    if (s.layout === "chart" && s.chart.length === 0)
      add(s, "empty-chart", "error", "Добавьте данные диаграммы.");
    if (s.layout === "table" && !s.table)
      add(s, "empty-table", "error", "Добавьте колонки и строки таблицы.");
    if (s.layout === "image" && !s.assetId)
      add(s, "empty-image", "error", "Выберите изображение.");
    if (s.layout === "steps") {
      const count = s.body.split(/\n\s*\n/).filter((p) => p.trim()).length;
      if (count < 2 || count > 4)
        add(
          s,
          "steps-count",
          "error",
          "Для плана действий нужны 2–4 шага, разделённые пустой строкой.",
        );
    }
    if (
      (s.metrics.length || s.chart.length) &&
      !s.sourceIds.length &&
      !s.metrics.some((m) => m.sourceId)
    )
      add(s, "missing-source", "warning", "У чисел нет указанного источника.");
  }
  if (doc.design === "focus-v3") {
    const statements = doc.slides.map((s, i) => [s, i] as const).filter(([s]) => s.layout === "statement");
    if (statements.length > 1)
      add(statements[1][0], "too-many-statements", "warning", "Больше одного тезиса на деку: оставьте один.");
    const firstEvidence = doc.slides.findIndex(s => ["split", "table", "metrics", "chart", "image"].includes(s.layout));
    if (statements.length && (firstEvidence < 0 || statements[0][1] < firstEvidence))
      add(statements[0][0], "statement-before-evidence", "warning", "Тезис стоит раньше первого доказательства.");
  }
  if (doc.brand.status !== "certified")
    out.push({
      code: "uncertified-brand",
      slideId: "",
      severity: "error",
      message: "Для выпуска нужен утверждённый шаблон.",
    });
  return out;
}
export function hasContrast(brand: Brand): boolean {
  const luminance = (hex: string) => {
    const a = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  };
  const contrast = (a: string, b: string) => {
    const x = luminance(a),
      y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  return (
    contrast(brand.ink, brand.paper) >= 4.5 &&
    contrast("#FFFFFF", brand.primary) >= 4.5
  );
}
export function propose(
  state: State,
  changes: { slideId: string; after: Slide }[],
  title: string,
  author: string,
): Proposal {
  if (!changes.length || changes.length > 40)
    throw new Error("Предложение должно менять от 1 до 40 слайдов.");
  if (new Set(changes.map((c) => c.slideId)).size !== changes.length)
    throw new Error("Один слайд может встречаться только один раз.");
  const entries = changes.map((c) => {
    const before = state.doc.slides.find((s) => s.id === c.slideId);
    if (!before) throw new Error("Слайд удалён или недоступен.");
    const after = slideSchema.parse(c.after);
    if (after.id !== before.id)
      throw new Error("Нельзя подменять идентификатор слайда.");
    return {
      id: uid(),
      slideId: c.slideId,
      before: structuredClone(before),
      after,
      status: "pending" as const,
    };
  });
  const candidate = structuredClone(state);
  for (const c of entries)
    candidate.doc.slides[
      candidate.doc.slides.findIndex((s) => s.id === c.slideId)
    ] = c.after;
  validateDoc(candidate.doc);
  validateReferences(candidate);
  return {
    id: uid(),
    title: title.slice(0, 140),
    author,
    baseRevision: state.revision,
    createdAt: new Date().toISOString(),
    changes: entries,
    status: "pending",
  };
}
/** Private document-level review; never publish through shared slide context. */
export function proposeBrief(state:State,input:unknown,title:string,author:string):Proposal {
  const changes=prepareBriefReview(state.doc.brief,input);
  return {id:uid(),title:z.string().trim().min(1).max(140).parse(title),author,baseRevision:state.revision,createdAt:new Date().toISOString(),changes:[],briefChanges:changes.map(c=>({...c,id:uid(),status:'pending'})),status:'pending'};
}
export function acceptProposal(
  state: State,
  proposalId: string,
  changeIds: string[],
): void {
  const p = state.proposals.find((p) => p.id === proposalId);
  if (!p || p.status !== "pending")
    throw new Error("Предложение закрыто или недоступно.");
  if (!changeIds.length || new Set(changeIds).size !== changeIds.length)
    throw new Error("Выберите изменения.");
  if(p.briefChanges){
    if(p.visibility==='shared'||p.draftCandidate||p.changes.length)throw Error('Некорректный тип предложения замысла.');
    const selected=changeIds.map(id=>{const change=p.briefChanges!.find(c=>c.id===id&&c.status==='pending');if(!change)throw Error('Изменение уже обработано.');return change;});
    const brief=acceptBriefReview(state.doc.brief,p.briefChanges.map(({id,status,...change})=>change),selected.map(c=>c.field));
    const doc=validateDoc({...state.doc,brief});state.doc=doc;
    for(const c of selected)c.status='accepted';
    if(p.briefChanges.every(c=>c.status!=='pending'))p.status='closed';
    return;
  }
  const selected = changeIds.map((id) => {
    const c = p.changes.find((c) => c.id === id && c.status === "pending");
    if (!c) throw new Error("Изменение уже обработано.");
    return c;
  });
  if(p.draftCandidate){
    if(state.revision!==p.baseRevision||canonicalJson(state.doc)!==canonicalJson(p.draftCandidate.before))throw Error('Конфликт версии. Заготовка изменилась; сохранённые правки защищены.');
    if(selected.length!==p.changes.length)throw Error('Первое заполнение принимается целиком.');
    const candidate=structuredClone(state);candidate.doc=validateDoc(p.draftCandidate.after);validateReferences(candidate);
    state.doc=candidate.doc;for(const c of selected)c.status='accepted';p.status='closed';return;
  }
  const slides=selected.map(c=>remainingSlide(state.doc.slides.find(s=>s.id===c.slideId),c));
  const candidate=structuredClone(state);
  selected.forEach((c,i)=>candidate.doc.slides[candidate.doc.slides.findIndex(s=>s.id===c.slideId)]=slides[i]);
  validateDoc(candidate.doc);validateReferences(candidate);
  selected.forEach((c,i)=>{
    state.doc.slides[state.doc.slides.findIndex(s=>s.id===c.slideId)]=slides[i];
    const ids=pendingObjects(c);
    if(ids)recordObjectDecisions(c,ids,"accepted");else c.status="accepted";
  });
  if (p.changes.every(c=>c.status!=="pending"))p.status="closed";
}
export function decideProposalObjects(state:State,proposalId:string,changeId:string,elementIds:string[],decision:"accepted"|"rejected") {
  const p=state.proposals.find(p=>p.id===proposalId&&p.status==="pending");
  if(p?.briefChanges)throw Error('Замысел принимается по полям, а не по объектам слайда.');
  if(p?.draftCandidate)throw Error('Первое заполнение принимается или отклоняется целиком.');
  const c=p?.changes.find(c=>c.id===changeId&&c.status==="pending");
  const pending=c&&pendingObjects(c);
  if(!p||!c||!pending||!elementIds.length||new Set(elementIds).size!==elementIds.length||elementIds.some(id=>!pending.includes(id)))
    throw new Error("Объект уже обработан или недоступен для отдельного решения.");
  if(decision==="accepted"){
    const index=state.doc.slides.findIndex(s=>s.id===c.slideId);
    const slide=mergeObjects(state.doc.slides[index],c,elementIds);
    const candidate=structuredClone(state);candidate.doc.slides[index]=slide;
    validateDoc(candidate.doc);validateReferences(candidate);
    state.doc.slides[index]=slide;
  }
  recordObjectDecisions(c,elementIds,decision);
  if(p.changes.every(c=>c.status!=="pending"))p.status="closed";
}
export function rejectProposal(state:State,proposalId:string) {
  const p=state.proposals.find(p=>p.id===proposalId&&p.status==="pending");
  if(!p)throw new Error("Предложение закрыто или недоступно.");
  for(const c of p.briefChanges??[])if(c.status==='pending')c.status='rejected';
  for(const c of p.changes.filter(c=>c.status==="pending")){
    const ids=pendingObjects(c);
    if(ids)recordObjectDecisions(c,ids,"rejected");else c.status="rejected";
  }
  p.status="closed";
}

export function changedContent(state: State) {
  state.doc = validateDoc(state.doc);
  validateReferences(state);
  state.revision++;
  state.approvedRevision = null;
  state.approvedBy = null;
}
export function demoDoc(): DeckDoc {
  const s1 = {
    ...blankSlide("cover"),
    eyebrow: "ПРИМЕР • СЕНТЯБРЬ 2026",
    title: "Большие идеи.\nОбщий язык.",
    body: "Презентации команды — от первого наброска до уверенного выступления.",
  };
  const s2 = {
    ...blankSlide("split"),
    eyebrow: "01 / КОНТЕКСТ",
    title: "Меньше ручной работы.\nБольше ясности.",
    body: "Единый визуальный язык\nКорпоративный шаблон уже внутри: типографика, цвета и композиция.\n\nСовместная работа\nАгент предлагает изменения. Команда проверяет, уточняет и выпускает.",
  };
  const s3 = {
    ...blankSlide("metrics"),
    eyebrow: "02 / ОРИЕНТИРЫ ПИЛОТА",
    title: "Что будем измерять",
    body: "Целевые показатели пилота, а не достигнутые результаты.",
    metrics: [
      { id: uid(), label: "Команда в пилоте", value: 1, unit: "команда" },
      {
        id: uid(),
        label: "Повторяющиеся сценарии",
        value: 3,
        unit: "сценария",
      },
      { id: uid(), label: "Цель: сокращение времени", value: 30, unit: "%" },
    ],
  };
  const s4 = {
    ...blankSlide("closing"),
    eyebrow: "03 / СЛЕДУЮЩИЙ ШАГ",
    title: "Начните со своей истории.",
    body: "Сформулируйте цель, проверьте логику и предложите корректировку. Изменения вступят в силу после принятия.",
    notes:
      "Это демонстрационная презентация. Замените примеры своими материалами.",
  };
  return {
    schemaVersion: 1,
    id: uid(),
    title: "Знакомство с Lanka Studio",
    brand: structuredClone(defaultBrand),
    design: defaultDesign,
    slides: [s1, s2, s3, s4],
  };
}
