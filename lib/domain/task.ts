import { z } from "zod";
import { briefSchema, intentSchema } from "./narrative";
import { docSchema, type DeckDoc, type Source } from "./model";
import { briefingFields, briefingPrompts, resolveBriefing, briefFromBriefing } from "./briefing";

export const taskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(140),
    brief: briefSchema.default({audience:"",decision:"",keyMessage:""}),
    workflow: z.enum(["draft", "formal"]).optional(),
    instruction: z.string().trim().max(4000),
    targetSlides: z.number().int().min(3).max(20),
    brandId: z.string().min(1).max(80),
  })
  .strict();
export type TaskInput = z.infer<typeof taskInputSchema>;
export const questionSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string().trim().min(1).max(700),
    reason: z.string().max(700),
    answer: z.string().max(2000).optional(),
    field: z.enum(briefingFields).optional(),
    suggestion: z.string().max(800).optional(),
    assumed: z.boolean().optional(),
  })
  .strict();
export const extractionSchema = z
  .object({
    sourceId: z.string().min(1).max(80),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["extracted", "partial", "unsupported", "failed"]),
    note: z.string().max(500),
    fragments: z
      .array(
        z
          .object({
            locator: z.string().min(1).max(150),
            text: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(80),
  })
  .strict();
export type Extraction = z.infer<typeof extractionSchema>;
export const planSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    slides: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: z.string().min(1).max(180),
            intent: intentSchema,
            sourceIds: z.array(z.string().max(80)).max(12),
            evidence: z
              .array(
                z
                  .object({
                    sourceId: z.string().max(80),
                    locator: z.string().max(150),
                  })
                  .strict(),
              )
              .max(12),
          })
          .strict(),
      )
      .min(3)
      .max(20),
    limitations: z.array(z.string().max(700)).max(12),
  })
  .strict();
export type StoryPlan = z.infer<typeof planSchema>;
export const taskStatuses = [
  "draft",
  "queued",
  "running",
  "awaiting_input",
  "awaiting_review",
  "completed",
  "cancelled",
  "failed",
] as const;
export const taskStatusNames: Record<(typeof taskStatuses)[number], string> = {
  draft: "Готовим материалы",
  queued: "В очереди",
  running: "Агент работает",
  awaiting_input: "Нужен ваш ответ",
  awaiting_review: "Готово к проверке",
  completed: "Результат принят",
  cancelled: "Отменено",
  failed: "Нужен повторный запуск",
};
export type TaskState = {
  input: TaskInput;
  status: (typeof taskStatuses)[number];
  phase: "brief" | "story" | "compose";
  briefingRequired?: boolean;
  workflow?: "draft" | "formal";
  briefConfirmedAt?: string;
  attempt: number;
  questions: z.infer<typeof questionSchema>[];
  extractions: Extraction[];
  plan?: StoryPlan;
  planAcceptedAt?: string;
  planPreparedAt?: string;
  candidate?: DeckDoc;
  critique?: string;
  error?: string;
  snapshot?: { doc: DeckDoc; sources: Source[]; baseRevision: number };
};
export type PresentationTask = {
  id: string;
  deckId: string;
  version: number;
  updatedAt: string;
  state: TaskState;
  role: "owner" | "editor" | "reviewer" | "viewer";
  leaseExpiresAt?: number;
};
export type TaskEvent = {
  sequence: number;
  kind: string;
  message: string;
  createdAt: string;
};
export function initialTaskState(input: TaskInput): TaskState {
  const workflow=input.workflow ?? "draft";
  const prepared=workflow==="draft"?{...input,brief:briefFromBriefing(resolveBriefing(undefined,input.brief))}:input;
  return {
    input:prepared,
    workflow,
    status: "draft",
    phase: workflow==="formal"?"brief":"story",
    briefingRequired: workflow==="formal",
    attempt: 0,
    questions: workflow==="formal"?briefingFields.map(field => ({id: crypto.randomUUID(), field, ...briefingPrompts[field], suggestion: input.brief[field]})):[],
    extractions: [],
  };
}
export const candidateSchema = docSchema;
