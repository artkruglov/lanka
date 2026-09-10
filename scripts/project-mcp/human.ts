import {assertProposalSources} from '../../lib/project/document-source-grant';
import {creationDesignBrand} from '../../lib/domain/creation-design';
import {checkEditorWrite} from '../../lib/project/editor-contract';
import { z } from "zod";
import type { ProjectRepository } from "../../lib/project/repository";
import { docSchema, validateDoc, validateReferences, initialState, changedContent, acceptProposal, decideProposalObjects, rejectProposal, uid } from "../../lib/domain/model";
import { fromMarkdown } from "../../lib/domain/intake";
import { resolveBriefing } from "../../lib/domain/briefing";
import { commentAnchor } from "../../lib/domain/comment-anchor";
const command = z.discriminatedUnion("action", [
  z.object({action: z.literal("create"), markdown: z.string().trim().min(1).max(30000), profile:z.enum(["focus-v2","focus-v3"]).optional()}).strict(),
  z.object({action: z.literal("save"), doc: docSchema, editorContract:z.string().optional()}).strict(),
  z.object({action: z.literal("restore"), revision: z.number().int().positive()}).strict(),
  z.object({action: z.literal("accept"), proposalId: z.string(), changeIds: z.array(z.string()).min(1).max(40)}).strict(),
  z.object({action:z.literal("review_objects"),proposalId:z.string(),changeId:z.string(),elementIds:z.array(z.string().min(1).max(80)).min(1).max(240),decision:z.enum(["accepted","rejected"])}).strict(),
  z.object({action: z.literal("reject"), proposalId: z.string()}).strict(),
  z.object({action: z.literal("comment"), slideId: z.string(), elementId:z.string().min(1).max(80).optional(), text: z.string().trim().min(1).max(2000)}).strict(),
  z.object({action: z.literal("resolve_comment"), commentId: z.string()}).strict(),
]);
export async function humanCommand(store: ProjectRepository, input: unknown, options:{requireEditorContract?:boolean}={}) {
  const a = z.object({requestId: z.string().uuid(), deckId: z.string().optional(), expectedRevision: z.number().int().positive().optional(), command}).strict().parse(input);
  return store.mutate(a.requestId, {surface: "human", ...a}, async old => {
    // The repository may return a verified receipt before entering this callback.
    // An obsolete save can replay its exact result, but can never execute a new write.
    if(options.requireEditorContract)checkEditorWrite(a);
    const c = a.command;
    if (c.action === "create") {
      if (old) throw new Error("В папке уже есть презентация.");
      const doc = fromMarkdown(c.markdown);
      if(c.profile){doc.design=c.profile;doc.brand=creationDesignBrand(c.profile);}
      return {project: {format: "lanka-project/v1", title: doc.title, state: initialState(doc), receipts: []}, result: {revision: 1}};
    }
    if (!old || a.deckId !== old.state.doc.id) throw new Error("Документ находится вне этого проекта.");
    if (a.expectedRevision !== old.state.revision) throw new Error("Конфликт версии. Правки сохранены на экране; загрузите актуальный документ перед повтором.");
    const p = structuredClone(old);
    if (c.action === "save") {
      const doc = validateDoc(c.doc);
      if (doc.id !== p.state.doc.id || JSON.stringify(doc.brand) !== JSON.stringify(p.state.doc.brand))
        throw new Error("Нельзя подменять документ или бренд.");
      p.state.doc = doc;
      p.title = doc.title;
      changedContent(p.state);
    } else if (c.action === "restore") {
      const entry = p.history?.find(h => h.revision === c.revision);
      if (!entry) throw new Error("Версия недоступна.");
      if(store.restoreRevision){
        const restored=await store.restoreRevision(c.revision);
        if(restored.doc.id!==p.state.doc.id)throw Error('Версия относится к другому документу.');
        p.state.doc=restored.doc;p.state.sources=restored.sources;
      }else p.state.doc = await store.readSnapshot(entry.hash);
      p.title = p.state.doc.title;
      validateReferences(p.state);
      changedContent(p.state);
    } else if (c.action === "accept") {
      assertProposalSources(p.state,c.proposalId,c.changeIds);
      acceptProposal(p.state, c.proposalId, c.changeIds);
      // Applying a change does not decide whether the reviewer's concern is resolved.
      changedContent(p.state);
    } else if (c.action === "reject") {
      rejectProposal(p.state,c.proposalId);
    } else if(c.action==="review_objects") {
      if(c.decision==="accepted")assertProposalSources(p.state,c.proposalId,[c.changeId]);
      decideProposalObjects(p.state,c.proposalId,c.changeId,c.elementIds,c.decision);
      if(c.decision==="accepted")changedContent(p.state);
    } else if(c.action === "resolve_comment") {
      const comment=p.state.comments.find(v=>v.id===c.commentId && !v.replyTo);
      if(!comment)throw new Error("Комментарий недоступен.");
      if(comment.visibility==="shared")throw new Error("Общее обсуждение изменяется через корпоративные команды обсуждения.");
      comment.resolved=!comment.resolved;
    } else {
      if (!p.state.doc.slides.some(s => s.id === c.slideId)) throw new Error("Слайд недоступен.");
      if (p.state.comments.length >= 300) throw new Error("Достигнут лимит комментариев.");
      const anchor=commentAnchor(p.state,c.slideId,c.elementId);
      p.state.comments.push({id: uid(), slideId: c.slideId, text: c.text, author: "Владелец проекта", createdAt: new Date().toISOString(), resolved: false,...(anchor?{anchor}:{})});
    }
    if(c.action==="save"||c.action==="restore") {
      if(p.state.doc.brief)p.briefing=resolveBriefing(undefined,p.state.doc.brief);
      else delete p.briefing;
    }
    return {project: p, result: {revision: p.state.revision}};
  });
}
