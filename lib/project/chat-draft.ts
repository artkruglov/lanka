import { z } from "zod";
import { chatInputSchema, selectionSchema, type ChatInput, type ChatSelection } from "../agents/contracts";

const draftSchema = z.object({
  text: z.string().max(8000), mode: z.enum(["discuss", "edit"]), scope: z.enum(["slide", "element", "document"]),
  pending: chatInputSchema.optional(), recoverPending: z.boolean().default(false),
  selection: selectionSchema.optional(),
});
type Draft = z.infer<typeof draftSchema>;
type StoragePort = Pick<Storage, "getItem" | "setItem">;
export function selectionForScope(selection:ChatSelection, scope:Draft["scope"]):ChatSelection|null {
  if(scope==="document")return {slideId:selection.slideId,field:null,scope};
  if(scope==="element")return selection.elementId?{slideId:selection.slideId,field:null,scope,elementId:selection.elementId}:null;
  return {slideId:selection.slideId,field:selection.elementId?null:selection.field,scope};
}

/** Per-tab, per-document storage; no credentials or shared conversation history. */
export class ChatDraft {
  private value: Draft = {text: "", mode: "discuss", scope: "slide", recoverPending: false};
  private readonly key: string;
  persistent: boolean;
  constructor(private storage: StoragePort | null, documentId: string) {
    this.key = `lanka:chat-draft:v1:${documentId}`;
    this.persistent = !!storage;
    try {
      const saved = storage?.getItem(this.key);
      if (saved) { const parsed = draftSchema.safeParse(JSON.parse(saved)); if (parsed.success) this.value = parsed.data; }
    } catch { this.persistent = false; }
  }
  get options() { return {mode: this.value.mode, scope: this.value.scope}; }
  get selection() { return this.value.selection; }
  get text() { return this.value.text || (this.value.recoverPending ? this.value.pending?.text || "" : ""); }
  private save() {
    try { this.storage?.setItem(this.key, JSON.stringify(this.value)); }
    catch { this.persistent = false; }
  }
  setText(text: string) {
    if (text === this.value.text) return;
    this.value.text = text.slice(0, 8000); this.value.recoverPending = false; this.save();
  }
  setOptions(options: Pick<Draft, "mode" | "scope">) { Object.assign(this.value, options); this.save(); }
  setSelection(selection: ChatSelection) { this.value.selection = selection; this.save(); }
  prepare(input: Omit<ChatInput, "requestId">): ChatInput {
    const old = this.value.pending;
    const candidate = chatInputSchema.parse({...input, requestId: old?.requestId || crypto.randomUUID()});
    const selectionKey = (s: ChatSelection) => s.scope === "document" ? "document" : JSON.stringify([s.slideId, s.field, s.elementId??null]);
    const sameIntent = old && old.text === candidate.text && old.mode === candidate.mode && (old.creationQuestionId === candidate.creationQuestionId || !!old.creationQuestionId && !candidate.creationQuestionId) && selectionKey(old.selection) === selectionKey(candidate.selection);
    // An ambiguous response is retried against the original revision, even after a reload/new revision.
    const pending = sameIntent ? old : {...candidate, requestId: old ? crypto.randomUUID() : candidate.requestId};
    this.value.pending = pending; this.value.recoverPending = true; this.save();
    return pending;
  }
  acknowledge(requestId: string) {
    if (this.value.pending?.requestId !== requestId) return;
    delete this.value.pending; this.value.recoverPending = false; this.save();
  }
}
