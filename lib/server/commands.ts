import {assertProposalSources} from '../project/document-source-grant';
import {
  fingerprint,
  lookupReceipt,
  type ReceiptIntent,
  type RunFence,
} from "./idempotency";
import { z } from "zod";
import { commentAnchor } from "../domain/comment-anchor";
import { database } from "@/db";
import {
  defaultBrand,
  docSchema,
  slideSchema,
  demoDoc,
  validateDoc,
  propose,
  acceptProposal,
  decideProposalObjects,
  rejectProposal,
  changedContent,
  lintDoc,
  uid,
  type State,
} from "@/lib/domain/model";
import { AppError, type Actor } from "./auth";
import {
  allow,
  createDeck,
  getDeck,
  saveDeck,
  resolveBrand,
  historicalDoc,
} from "./store";
import { scene } from "@/lib/domain/scene";
import { fromMarkdown } from "@/lib/domain/intake";
import { resolveBriefing, briefFromBriefing } from "@/lib/domain/briefing";
import { semanticCommandsSchema, compileCommands } from "@/lib/domain/commands";
import { materialInputsSchema } from "@/lib/domain/material-input";
const base = z
  .object({
    action: z.string(),
    requestId: z.string().uuid().optional(),
    deckId: z.string().max(80).optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .passthrough();
export const agentActions = new Set(["create", "propose", "propose_commands", "reply", "comment"]);
async function executeCommand(
  actor: Actor,
  body: unknown,
  surface: "human" | "agent",
  context: { receipt?: ReceiptIntent; run?: RunFence },
) {
  const b = base.parse(body);
  if (surface === "agent" && !agentActions.has(b.action))
    throw new AppError(
      403,
      "Агент может создавать черновики, предлагать правки и оставлять комментарии.",
    );
  if (b.action === "create") {
    const c = z
      .object({
        demo: z.boolean().optional(),
        markdown: z.string().max(30_000).optional(),
        title: z.string().min(1).max(140).optional(),
        brandId: z.string().optional(),
        doc: docSchema.optional(),
        materials: materialInputsSchema.default([]),
      })
      .parse(b);
    let doc = c.demo
      ? demoDoc()
      : c.doc
        ? validateDoc(c.doc)
        : fromMarkdown(c.markdown || "", c.title || "Новая презентация");
    doc.brand = await resolveBrand(
      actor,
      c.brandId || doc.brand.id || defaultBrand.id,
    );
    if(surface==="agent") {
      if(!c.doc && !c.markdown?.trim())throw new AppError(400,"Передайте содержание презентации: doc или markdown.");
      doc.brief=briefFromBriefing(resolveBriefing(b.briefing,doc.brief));
    }
    return createDeck(actor, doc, context.receipt, undefined, c.materials);
  }
  if (!b.deckId) throw new AppError(400, "Не указана презентация.");
  const old = await getDeck(actor, b.deckId),
    state: State = structuredClone(old.state);
  if (b.expectedRevision === undefined || b.expectedRevision !== state.revision)
    throw new AppError(
      409,
      "Версия документа изменилась. Обновите презентацию.",
    );
  let content = false,
    share = false,
    release = false;
  switch (b.action) {
    case "propose_commands": {
      allow(old,["owner","editor"]);
      const v=z.object({title:z.string().trim().min(1).max(140),commands:semanticCommandsSchema,feedbackIds:z.array(z.string()).max(12).default([])}).parse(b);
      if(state.proposals.filter(p=>p.status==="pending").length>=12)throw new AppError(400,"Сначала обработайте предложения.");
      if(v.feedbackIds.some(id=>!state.comments.some(c=>c.id===id && !c.replyTo)))throw new AppError(404,"Комментарий недоступен.");
      const p=propose(state,compileCommands(state.doc,v.commands),v.title,surface==="agent"?"Агент · "+actor.email:actor.email);
      p.feedbackIds=v.feedbackIds;state.proposals.push(p);
      break;
    }
    case "reply": {
      allow(old,["owner","editor"]);
      const v=z.object({commentId:z.string(),text:z.string().trim().min(1).max(2000),proposalId:z.string().optional()}).parse(b);
      const parent=state.comments.find(c=>c.id===v.commentId && !c.replyTo);
      if(!parent)throw new AppError(404,"Комментарий недоступен.");
      if(v.proposalId && !state.proposals.some(p=>p.id===v.proposalId && p.changes.some(c=>c.slideId===parent.slideId)))throw new AppError(404,"Предложение не относится к слайду.");
      if(state.comments.length>=300)throw new AppError(400,"Достигнут лимит комментариев.");
      state.comments.push({id:uid(),slideId:parent.slideId,replyTo:parent.id,proposalId:v.proposalId,text:v.text,author:surface==="agent"?"Агент · "+actor.email:actor.email,createdAt:new Date().toISOString(),resolved:false,...(parent.anchor?{anchor:parent.anchor}:{})});
      break;
    }
    case "save": {
      allow(old, ["owner", "editor"]);
      const v = z.object({ doc: docSchema }).parse(b);
      const next = validateDoc(v.doc);
      if (next.id !== old.id)
        throw new AppError(400, "Нельзя менять идентификатор документа.");
      if (JSON.stringify(next.brand) !== JSON.stringify(state.doc.brand))
        throw new AppError(400, "Меняйте шаблон отдельной командой.");
      state.doc = next;
      content = true;
      break;
    }
    case "brand": {
      allow(old, ["owner", "editor"]);
      const v = z.object({ brandId: z.string() }).parse(b);
      state.doc.brand = await resolveBrand(actor, v.brandId);
      content = true;
      break;
    }
    case "propose": {
      allow(old, ["owner", "editor"]);
      const v = z
        .object({
          title: z.string().min(1).max(140),
          changes: z
            .array(
              z.object({ slideId: z.string(), after: slideSchema }).strict(),
            )
            .min(1)
            .max(40),
        })
        .parse(b);
      if (state.proposals.filter((p) => p.status === "pending").length >= 12)
        throw new AppError(400, "Сначала обработайте открытые предложения.");
      state.proposals = state.proposals
        .filter((p) => p.status === "pending")
        .concat(
          state.proposals.filter((p) => p.status === "closed").slice(-10),
        );
      state.proposals.push(
        propose(
          state,
          v.changes,
          v.title,
          surface === "agent" ? `Агент · ${actor.email}` : actor.email,
        ),
      );
      break;
    }
    case "accept": {
      allow(old, ["owner", "editor", "reviewer"]);
      const v = z
        .object({
          proposalId: z.string(),
          changeIds: z.array(z.string()).min(1).max(40),
        })
        .parse(b);
      assertProposalSources(state,v.proposalId,v.changeIds);
      acceptProposal(state, v.proposalId, v.changeIds);
      const accepted=state.proposals.find(p=>p.id===v.proposalId)!;
      if(accepted.changes.every(c=>c.status==="accepted"&&!c.objectDecisions?.some(d=>d.status==="rejected")))for(const id of accepted.feedbackIds || []) {
        const c=state.comments.find(c=>c.id===id);if(c&&c.visibility!=="shared")c.resolved=true;
      }
      content = true;
      break;
    }
    case "reject": {
      allow(old, ["owner", "editor", "reviewer"]);
      const v = z.object({ proposalId: z.string() }).parse(b);
      rejectProposal(state,v.proposalId);
      break;
    }
    case "review_objects": {
      allow(old,["owner","editor","reviewer"]);
      const v=z.object({proposalId:z.string(),changeId:z.string(),elementIds:z.array(z.string().min(1).max(80)).min(1).max(240),decision:z.enum(["accepted","rejected"])}).parse(b);
      if(v.decision==="accepted")assertProposalSources(state,v.proposalId,[v.changeId]);
      decideProposalObjects(state,v.proposalId,v.changeId,v.elementIds,v.decision);
      content=v.decision==="accepted";
      break;
    }
    case "comment": {
      allow(old, ["owner", "editor", "reviewer"]);
      const v = z
        .object({
          slideId: z.string(),
          text: z.string().trim().min(1).max(2000),
          elementId:z.string().min(1).max(80).optional(),
        })
        .parse(b);
      if (!state.doc.slides.some((s) => s.id === v.slideId))
        throw new AppError(404, "Слайд недоступен.");
      if (state.comments.length >= 300)
        throw new AppError(400, "Достигнут лимит комментариев для пилота.");
      state.comments.push({
        id: uid(),
        slideId: v.slideId,
        text: v.text,
        author: actor.email,
        createdAt: new Date().toISOString(),
        resolved: false,
        anchor:commentAnchor(state,v.slideId,v.elementId),
      });
      break;
    }
    case "resolve": {
      allow(old, ["owner", "editor", "reviewer"]);
      const v = z.object({ commentId: z.string() }).parse(b);
      const c = state.comments.find((c) => c.id === v.commentId);
      if (!c) throw new AppError(404, "Комментарий недоступен.");
      if(c.visibility==="shared")throw new AppError(409,"Общее обсуждение изменяется через корпоративные команды обсуждения.");
      c.resolved = !c.resolved;
      break;
    }
    case "approve": {
      const task = await database()
        .prepare("SELECT state FROM presentation_tasks WHERE deck_id = ?")
        .bind(old.id)
        .first<{ state: string }>();
      if (
        task &&
        !["completed", "cancelled"].includes(JSON.parse(task.state).status)
      )
        throw new AppError(
          409,
          "Сначала завершите или отмените задачу подготовки презентации.",
        );
      allow(old, ["owner", "reviewer"]);
      if (
        state.doc.slides.some(
          (s, i) =>
            scene(s, state.doc.brand, i, state.doc.slides.length, state.doc.design).overflow,
        )
      )
        throw new AppError(400, "Текст выходит за пределы слайда.");
      const errors = lintDoc(state.doc).filter((l) => l.severity === "error");
      if (errors.length)
        throw new AppError(400, errors.map((e) => e.message).join(" "));
      if (state.proposals.some((p) => p.status === "pending"))
        throw new AppError(
          400,
          "Обработайте открытые предложения перед утверждением.",
        );
      state.approvedRevision = state.revision;
      state.approvedBy = actor.email;
      break;
    }
    case "release": {
      allow(old, ["owner", "reviewer"]);
      if (state.proposals.some((p) => p.status === "pending"))
        throw new AppError(400, "Обработайте открытые предложения.");
      if (state.approvedRevision !== state.revision)
        throw new AppError(409, "Сначала утвердите текущую версию.");
      release = true;
      break;
    }
    case "restore": {
      allow(old, ["owner", "editor"]);
      const v = z.object({ revision: z.number().int().positive() }).parse(b);
      state.doc = await historicalDoc(actor, old.id, v.revision);
      content = true;
      break;
    }
    case "share": {
      allow(old, ["owner"]);
      const v = z
        .object({
          grants: z
            .array(
              z.object({
                email: z.string().email().max(250),
                role: z.enum(["viewer", "editor", "reviewer"]),
              }),
            )
            .max(30),
        })
        .parse(b);
      state.grants = v.grants.map((g) => ({
        ...g,
        email: g.email.toLowerCase(),
      }));
      if (
        new Set(state.grants.map((g) => g.email)).size !== state.grants.length
      )
        throw new AppError(400, "Один адрес указан несколько раз.");
      share = true;
      break;
    }
    default:
      throw new AppError(400, "Неизвестная команда.");
  }
  if (content) changedContent(state);
  return saveDeck(actor, old, state, b.action, {
    share,
    release,
    receipt: context.receipt,
    run: context.run
      ? { ...context.run, proposalId: state.proposals.at(-1)?.id }
      : undefined,
  });
}

/** Receipt and document mutation commit together. Replays recheck current ACL. */
export async function command(
  actor: Actor,
  body: unknown,
  surface: "human" | "agent" = "human",
  context: { run?: RunFence } = {},
) {
  const b = base.parse(body);
  if (surface === "agent" && !agentActions.has(b.action))
    throw new AppError(
      403,
      "Агент может создавать черновики, предлагать правки и оставлять комментарии.",
    );
  if (surface === "agent" && !b.requestId && !context.run)
    throw new AppError(
      400,
      "Передайте requestId (UUID) и сохраняйте его при повторной отправке.",
    );
  const { requestId, ...payload } = b;
  const receipt: ReceiptIntent | undefined = requestId
    ? {
        requestId,
        actorId: actor.id,
        action: b.action,
        fingerprint: await fingerprint({ surface, payload }),
      }
    : undefined;
  const replay = async () => {
    if (!receipt) return null;
    const r = await lookupReceipt(receipt);
    if (!r) return null;
    return {
      ...(await getDeck(actor, r.deckId)),
      receipt: { requestId: r.requestId, revision: r.revision, replayed: true },
    };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    const result = await executeCommand(actor, b, surface, {
      ...context,
      receipt,
    });
    return {
      ...result,
      ...(receipt
        ? {
            receipt: {
              requestId: receipt.requestId,
              revision: result.state.revision,
              replayed: false,
            },
          }
        : {}),
    };
  } catch (error) {
    const concurrent = await replay();
    if (concurrent) return concurrent;
    throw error;
  }
}
