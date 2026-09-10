import { z } from "zod";
import { semanticCommandSchema } from "../domain/commands";

export const selectionSchema = z.object({
  slideId: z.string().min(1).max(80),
  field: z.enum(["title", "body", "takeaway"]).nullable().default(null),
  scope: z.enum(["slide", "element", "document"]).optional(),
  elementId: z.string().min(1).max(80).optional(),
}).strict().refine(v => v.scope !== "document" || v.field === null, "Для всей презентации выберите область без отдельного поля.")
  .refine(v=>v.elementId ? v.scope==="element"&&v.field===null : v.scope!=="element", "Для области объекта укажите только elementId и его слайд.");
export const chatInputSchema = z.object({
  requestId: z.string().uuid(), text: z.string().trim().min(1).max(8000),
  creationQuestionId: z.string().uuid().optional(),
  mode: z.enum(["discuss", "edit"]), expectedRevision: z.number().int().positive(),
  selection: selectionSchema,
}).strict();
export const runInputSchema = chatInputSchema.extend({mode: z.enum(["discuss", "edit", "create"])});
export const creationMaterialSchema = z.object({name:z.string().trim().min(1).max(140),text:z.string().trim().min(1).max(12000)}).strict();
export const createPresentationSchema = z.object({requestId:z.string().uuid(), prompt:z.string().trim().min(1).max(8000), material:creationMaterialSchema.optional(), sourceIntakeId:z.string().uuid().optional(), folderId:z.string().uuid().nullable().default(null),profile:z.enum(["focus-v2","focus-v3"]).optional()}).strict();
export const editAnswerSchema = z.object({
  reply: z.string().trim().min(1).max(8000),
  title: z.string().trim().min(1).max(140),
  commands: z.array(semanticCommandSchema.refine(c=>["set_title","set_body","set_takeaway"].includes(c.op),"Это подключение поддерживает только правки заголовка, текста и тезиса.")).max(80),
}).strict();
export type ChatInput = z.infer<typeof chatInputSchema>;
export type ChatSelection = z.infer<typeof selectionSchema>;
export type ChatMessage = {
  id: string; role: "user" | "assistant"; text: string;
  status: "complete" | "streaming" | "interrupted" | "failed";
  mode: "discuss" | "edit" | "create"; selection: ChatSelection; proposalId: string | null; createdAt: string;
};
export type ChatView = {
  sessionId: string; messages: ChatMessage[]; cursor: number;
  inputRequests?: {id:string;kind?:"confirmation"|"question";questions:{id:string;header:string;question:string;isOther:boolean;options:{label:string;description:string}[]|null}[]}[];
  recovery?: {failedRunId:string};
  creationQuestion?: {id:string;question:string};
  contextRestartedAt?: string;
  active: {id: string; status: string; mode: string; interruptAcknowledged: boolean; activity?:string} | null;
  queued: number;
};
export type AgentUsage = {limit:number;used:number;queued:number;remaining:number;resetsAt:string};
export type AgentConnectionView = {
  usage?: AgentUsage;
  available: boolean; enabled: boolean;
  status: "not_configured" | "ready" | "auth_required" | "offline" | "disabled" | "verifying";
  name: string; version?: string; model?: string; checkedAt?: string;
  runtimeMode?: 'configured' | 'dedicated';
  message?: string; auth?: {attemptId: string; url: string; code?: string};
  capabilities: {chat: boolean; streaming: boolean; toolMode: "supervised_json" | "native_mcp"; resume: "exact"};
};
