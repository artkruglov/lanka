import {briefReviewInputSchema} from '../../lib/domain/brief-review';
import {resolve} from "node:path";
import {registerImage} from './image-source';
import { storyView, authoringGuide } from "../../lib/domain/authoring";
import { commentAnchor } from "../../lib/domain/comment-anchor";
import { creationProfile } from "../../lib/agents/creation-profile";
import { assertEditDesign } from "../../lib/agents/edit-design";
import { canPopulateDraft, populateDraft } from "../../lib/project/empty-draft";
import { briefingInputSchema, briefingPrompts, briefingAssumptions, resolveBriefing, briefFromBriefing } from "../../lib/domain/briefing";
import { semanticCommandsSchema, compileCommands } from "../../lib/domain/commands";
import { waitForFeedback } from "./feedback";
import { createHash } from "node:crypto";
import { materialPath } from "../../lib/project/package";
import { z } from "zod";
import type { ProjectRepository } from "../../lib/project/repository";
import { type FolderProject } from "../../lib/project/package";
import { fromMarkdown } from "../../lib/domain/intake";
import {
  initialState,
  validateDoc,
  validateReferences,
  lintDoc,
  propose,
  proposeBrief,
  uid,
  docSchema,
  slideSchema,
  type State,
} from "../../lib/domain/model";
import { inspectNarrative } from "../../lib/domain/narrative";
import { designReview } from "../../lib/domain/design-review";
import { scene } from "../../lib/domain/scene";
import {isDataObject,renderDataObject,minimumDataBox} from '../../lib/domain/data-object';
import {dataSizeOptions} from '../../lib/domain/data-layout';
import {applyDataObjectChange} from '../../lib/domain/data-draft';
import {canvasElementSchema} from '../../lib/domain/model';
import { renderProjectExport } from "./export";
import { previewSlides } from "./preview";
const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" },
  key = { type: "string", format: "uuid", description:"A new valid UUID for each distinct mutation. Reuse it only when retrying identical request bytes after a lost response; do not use a descriptive label." },
  rev = { type: "integer", minimum: 1 };
export const projectTools = [
  {name:'list_exports',description:'List immutable saved PDF/PPTX artifacts for this document, newest first. Each item identifies the exact revision; these are downloads, not publication approvals. Older unregistered exports are not included.',inputSchema:schema({deckId:str,cursor:{type:'string',format:'uuid'}},['deckId'])},
  {name:'get_export_artifact',description:'Read an existing export manifest and download location without re-rendering. Includes the exact document snapshot, verified source/font hashes and renderer build. New manifests include per-object capabilities; older manifests may omit them. PPTX fonts are not embedded. This does not share or approve a release.',inputSchema:schema({deckId:str,artifactId:{type:'string',format:'uuid'}},['deckId','artifactId'])},
  {name:"suggest_data_size",description:"Read-only size alternatives for an existing canvas chart/table, preserving all neighbours, data and style. Optional data contains the complete proposed chart/table data with stable IDs and numeric values. Returns up to two complete set_element commands; does not save or create a proposal. Use propose_commands, then inspect render_slides for the proposal. Exact revision required; no automatic unlocking or template conversion.",inputSchema:schema({deckId:str,expectedRevision:rev,slideId:str,elementId:str,data:{type:"object"}},["deckId","expectedRevision","slideId","elementId"])},
  {name:"render_slides",description:"See the saved presentation as PNG images rendered from its canonical PDF with embedded fonts. Inspect every slide after creation, in batches of up to two slide IDs. Read-only, exact revision; no model-provided paths. Omit proposalId for saved slides. Pass a pending proposalId to inspect all its remaining changes applied to the current document without accepting; conflicts and closed proposals are rejected. Requires Poppler on the local server.",inputSchema:schema({deckId:str,expectedRevision:rev,proposalId:str,slideIds:{type:"array",items:str,minItems:1,maxItems:2,uniqueItems:true}},["deckId","expectedRevision","slideIds"])},
  {name:"populate_draft",description:"Fill a pristine empty presentation created in the UI. First read get_project and its authoring guide. Submit complete slide objects in the current design; the server preserves the user's name, brand and design. Only when canPopulate is true. Optional title is accepted ONLY when get_project.canSetTitle is true (automatically named chat draft). Revision conflict or human edits stop replacement. The same requestId safely replays a lost response. Include optional briefing from the user's prompt without asking them to repeat it; mark inferred values as assumption. Existing document context is protected.",inputSchema:schema({requestId:key,deckId:str,expectedRevision:rev,title:str,briefing:{type:"object",description:"Optional audience, decision, keyMessage; each is {value:string,origin:'user'|'assumption'}. Origin user only for information explicitly supplied; missing values remain assumptions."},slides:{type:"array",items:{type:"object"},minItems:1,maxItems:40}},["requestId","deckId","expectedRevision","slides"])},
  {name:"get_design_profile",description:"Read a pinned design package with composition rules, brand and visual references. Use it before authoring. Reference content is illustrative, not a source of facts.",inputSchema:schema({profile:{type:"string",enum:["focus-v2","focus-v3"]}},["profile"])},
  {name:"export_handoff",description:"Export canonical content and verified source bytes for importing into the cloud editor. This does not upload or share anything. Human imports the resulting JSON in Lanka, then receives a permanent editable link. Grants, approvals and local receipts are excluded.",inputSchema:schema({deckId:str,expectedRevision:rev},["deckId","expectedRevision"])},
  {name:"get_briefing_questions",description:"Optional questions when missing context materially changes the presentation. Ordinary drafts may start without an interview. Preserve unknown answers as assumptions, never as confirmed facts.",inputSchema:schema({})},
  {name:"wait_for_feedback",description:"Wait up to 20 seconds for comments, review decisions or a new revision in this project. Resume work in this same agent session. Repeat only while the user requested a live review. Does not wake a terminated session.",inputSchema:schema({deckId:str,cursor:str,timeoutMs:{type:"integer",minimum:0,maximum:20000}},["deckId"])},
  {name:"propose_brief",description:"Propose document-level audience, decision or keyMessage for human review. Read get_project first. Values are suggestions, not confirmed answers until human acceptance. Does not change slides or the saved brief. A field can be an empty string to propose clearing it. Review the returned field changes and proposalId; do not render it as slide edits. Private local project context only.",inputSchema:schema({requestId:key,deckId:str,expectedRevision:rev,title:str,fields:{type:"object",properties:{audience:{type:"string",maxLength:400},decision:{type:"string",maxLength:800},keyMessage:{type:"string",maxLength:800}},additionalProperties:false,minProperties:1}},["requestId","deckId","expectedRevision","title","fields"])},
  {name:"propose_commands",description:"Edits compiled into a review proposal. Template slides: set_title/body/takeaway/layout/table/comparison/chart/image. If slide.canvas exists prefer edit_text (elementId, value:{text?,size?,bold?}; height grows automatically) for text-only edits; otherwise use set_element/add_element (value: complete object with stable id) or remove_element (elementId). Use insert_text (elementId:new stable ID,value:text) or insert_shape (elementId:new stable ID) for new canvas objects with automatic placement and brand defaults. Use insert_image (elementId:new stable ID,assetId:registered image source) to place a new canvas image automatically. Use align_element (elementId,direction:left/center/right/top/middle/bottom) for alignment to slide bounds. Use reorder_element (elementId,direction:front/back/forward/backward) for layer order. Read get_authoring_guide.directEditing. set_intent uses value:{role,takeaway,transition,openQuestions} to create or replace the complete narrative intent, including on canvas slides; requires slide/document scope, not a selected text field or object. Human accepts; never modify main.",inputSchema:schema({requestId:key,deckId:str,expectedRevision:rev,title:str,commands:{type:"array",items:{type:"object"}},feedbackIds:{type:"array",items:str}},["requestId","deckId","expectedRevision","title","commands"])},
  {name:"reply_to_feedback",description:"Reply to a human slide comment and optionally link your pending proposal. Does not resolve the comment or accept changes.",inputSchema:schema({requestId:key,deckId:str,expectedRevision:rev,commentId:str,text:str,proposalId:str},["requestId","deckId","expectedRevision","commentId","text"])},
  {name:"register_source",description:"Register immutable source bytes: PNG/JPEG up to 5 MB; text/CSV/JSON up to 600 KB. Images are decoded, EXIF orientation is normalized, originals are retained; returns usable sourceId and image dimensions. No URL fetch or filesystem paths. Returns a content hash and source ID usable by charts, tables and images.",inputSchema:schema({requestId:key,deckId:str,expectedRevision:rev,name:str,contentType:str,base64:str},["requestId","deckId","expectedRevision","name","contentType","base64"])},
  { name: "get_authoring_guide", description: "Read the document example, design systems, composition budgets and authoring workflow before creating a deck.", inputSchema: schema({}) },
  { name: "get_story", description: "Read the brief, ordered takeaways and transitions separately from the visual realization. Includes human feedback from this project.", inputSchema: schema({deckId: str}, ["deckId"]) },
  {
    name: "get_project",
    description:
      "Read the one configured document, its current revision, comments and canPopulate flag. No other clients or documents are discoverable.",
    inputSchema: schema({}),
  },
  {
    name: "create_deck",
    description:
      "Create the first draft in an empty project from explicit content. No model is called by this tool.",
    inputSchema: schema(
      {
        requestId: key,
        briefing: {type:"object",description:"Optional audience, decision, keyMessage: each supplied field is {value:string,origin:'user'|'assumption'}. Missing fields remain explicit assumptions; an interview is not required."},
        sources: {type:"array",description:"Optional initial text/CSV/JSON material snapshots: {name,contentType,base64}. Reference each by src- plus SHA-256 of its decoded bytes.",items:{type:"object"}},
        title: str,
        markdown: { type: "string", maxLength: 30000 },
        doc: {
          type: "object",
          description:
            "Optional complete Lanka DeckDoc; requires valid schema and sources.",
        },
      },
      ["requestId"],
    ),
  },
  {
    name: "propose_changes",
    description:
      "Submit changed slide objects for human review; never change the main document.",
    inputSchema: schema(
      {
        requestId: key,
        deckId: str,
        expectedRevision: rev,
        title: str,
        changes: { type: "array", items: { type: "object" } },
      },
      ["requestId", "deckId", "expectedRevision", "title", "changes"],
    ),
  },
  {
    name: "add_comment",
    description: "Save feedback anchored to a slide or its canvas object. Optional elementId is validated in the saved slide; the server preserves the original quote and revision. Replies inherit the anchor. Deleted objects do not retarget comments.",
    inputSchema: schema(
      {
        requestId: key,
        deckId: str,
        expectedRevision: rev,
        slideId: str,
        elementId: str,
        text: { type: "string", maxLength: 2000 },
      },
      ["requestId", "deckId", "expectedRevision", "slideId", "text"],
    ),
  },
  {
    name: "lint_deck",
    description:
      "Check layout and narrative completeness; not factual validation.",
    inputSchema: schema({ deckId: str }, ["deckId"]),
  },
  {
    name: "export_deck",
    description:
      "Export the current saved draft in this project as an editable PPTX or PDF. This is not publication or approval.",
    inputSchema: schema(
      {
        deckId: str,
        expectedRevision: rev,
        format: { type: "string", enum: ["pptx", "pdf"] },
      },
      ["deckId", "expectedRevision", "format"],
    ),
  },
];
const receipt = z.string().uuid();
function requireProject(
  p: FolderProject | null,
  a: Record<string, unknown>,
  revision = false,
) {
  if (!p) throw new Error("Project is empty");
  if (p.state.doc.id !== a.deckId)
    throw new Error("Deck is outside this project");
  if (revision && a.expectedRevision !== p.state.revision)
    throw new Error("Revision conflict");
  return p;
}
export interface AgentRepository extends ProjectRepository { readonly documentId?:string; writeMaterial(bytes:Buffer):Promise<string>; }
export async function readAuthoringTool(name:string,a:Record<string,unknown>) {
  if(name==="get_design_profile")return creationProfile(z.object({profile:z.enum(["focus-v2","focus-v3"])}).strict().parse(a).profile);
  if(name==="get_briefing_questions") {
    z.object({}).strict().parse(a);
    return {questions:briefingPrompts,rule:"Ask only when missing context matters. Draft creation does not require these answers. Preserve assumptions and never invent evidence or claim an interview took place."};
  }
  if(name==="get_authoring_guide") {
    if(Object.keys(a).length)throw new Error("get_authoring_guide takes no paths");
    return authoringGuide;
  }
  throw new Error("Unknown authoring tool");
}
export async function invokeProjectTool(store:AgentRepository,name: string, a: Record<string, unknown>) {
  if(name==='suggest_data_size'){
    const args=z.object({deckId:z.string(),expectedRevision:z.number().int().positive(),slideId:z.string(),elementId:z.string(),data:z.record(z.unknown()).optional()}).strict().parse(a);
    const p=requireProject(await store.read(),args,true),s=p.state.doc.slides.find(v=>v.id===args.slideId),current=s?.canvas?.find(e=>e.id===args.elementId);
    if(!s?.canvas||!current||!isDataObject(current))throw Error('Нужна существующая таблица или диаграмма свободного редактора.');
    if(current.locked)throw Error('Объект заблокирован. Размер не изменён.');
    const value=canvasElementSchema.parse({...current,data:args.data??current.data});
    if(!isDataObject(value))throw Error('Unsupported data object');
    const checked=structuredClone(p.state);checked.doc=applyDataObjectChange(checked.doc,s.id,value,current);validateReferences(checked);
    const options=dataSizeOptions(value,current,s.canvas).map(o=>({label:o.label,command:{op:'set_element',slideId:s.id,value:{...value,...o.box}}}));
    return {deckId:args.deckId,revision:p.state.revision,slideId:s.id,elementId:current.id,status:options.length?'options':renderDataObject(value).overflow?(minimumDataBox(value)?'no_safe_size':'content_does_not_fit'):'already_fits',options};
  }
  if(["get_design_profile","get_briefing_questions","get_authoring_guide"].includes(name))return readAuthoringTool(name,a);
  if(name==="render_slides") {
    const args=z.object({deckId:z.string(),expectedRevision:z.number().int().positive(),proposalId:z.string().min(1).optional(),slideIds:z.array(z.string()).min(1).max(2).refine(ids=>new Set(ids).size===ids.length,"Duplicate slide IDs")}).strict().parse(a);
    return previewSlides(store,requireProject(await store.read(),args,true),args.slideIds,args.proposalId);
  }
  if(name==="populate_draft") {
    const args=z.object({requestId:receipt,deckId:z.string(),expectedRevision:z.number().int().positive(),title:z.string().trim().min(1).max(140).optional(),briefing:briefingInputSchema.optional(),slides:z.array(slideSchema).min(1).max(40)}).strict().parse(a);
    return store.mutate(args.requestId,{name,args},async old=>{
      const p=requireProject(old,args,true),project=populateDraft(p,args.slides,args.briefing,args.title);
      return {project,result:{deckId:args.deckId,revision:project.state.revision,slideCount:project.state.doc.slides.length}};
    });
  }
  if(name === "wait_for_feedback") {
    const args=z.object({deckId:z.string(),cursor:z.string().regex(/^[a-f0-9]{64}$/).optional(),timeoutMs:z.number().int().min(0).max(20000).default(20000)}).strict().parse(a);
    return waitForFeedback(store,args.deckId,args.cursor,args.timeoutMs);
  }
  if (name === "get_story") {
    const args = z.object({deckId: z.string()}).strict().parse(a);
    const p = requireProject(await store.read(), args);
    return {revision: p.state.revision, ...storyView(p.state.doc), comments: p.state.comments};
  }
  if (name === "get_project") {
    if (Object.keys(a).length) throw new Error("get_project takes no paths");
    const p = await store.read();
    return p
      ? { format: p.format, title: p.title, state: p.state, briefing: p.briefing,canPopulate:canPopulateDraft(p),canSetTitle:canPopulateDraft(p)&&p.draftShell?.allowTitle===true,...(store.documentId?{editorPath:`/documents/${store.documentId}`}:{}) }
      : { empty: true,...(store.documentId?{deckId:store.documentId}:{} ) };
  }
  if (name === "create_deck") {
    const args = z
      .object({
        requestId: receipt,
        briefing: briefingInputSchema.optional(),
        sources: z.array(z.object({name:z.string().trim().min(1).max(140),contentType:z.enum(["text/plain","text/markdown","text/csv","application/json"]),base64:z.string().min(4).max(800000).regex(/^[A-Za-z0-9+/]*={0,2}$/)}).strict()).max(8).default([]),
        title: z.string().max(140).optional(),
        markdown: z.string().max(30000).optional(),
        doc: docSchema.optional(),
      })
      .strict()
      .parse(a);
    return store.mutate(args.requestId, { name, args }, async (old) => {
      if (old) throw new Error("Project already contains a presentation");
      if (!args.doc && !args.markdown?.trim())
        throw new Error("Provide explicit content");
      const doc = args.doc
        ? validateDoc(args.doc)
        : fromMarkdown(args.markdown!, args.title);
      if(!args.doc&&store.documentId)doc.id=store.documentId;
      const state = initialState(doc);
      for(const source of args.sources) {
        const bytes=Buffer.from(source.base64,"base64");
        if(bytes.toString("base64")!==source.base64)throw new Error("Invalid base64");
        const sha256=await store.writeMaterial(bytes);
        if(state.sources.some(s=>s.sha256===sha256))continue;
        state.sources.push({id:`src-${sha256}`,sha256,name:source.name,contentType:source.contentType,kind:"text",createdAt:new Date().toISOString(),excerpt:bytes.toString("utf8").slice(0,1500)});
      }
      const briefing=resolveBriefing(args.briefing,doc.brief);
      state.doc.brief = briefFromBriefing(briefing);
      const assumptions=briefingAssumptions(briefing);
      if(assumptions.length)state.comments.push({id:uid(),slideId:doc.slides[0].id,text:`Рабочие допущения брифа (не ответы заказчика):\n${assumptions.join("\n")}`,author:"Брифинг",createdAt:new Date().toISOString(),resolved:false});
      validateReferences(state);
      return {
        project: {
          format: "lanka-project/v1",
          title: doc.title,
          state,
          receipts: [],
          briefing,
        },
        result: { deckId: doc.id, revision: 1, slideCount: doc.slides.length },
      };
    });
  }
  if(name==='propose_brief'){
    const args=z.object({requestId:receipt,deckId:z.string(),expectedRevision:z.number().int().positive(),title:z.string().trim().min(1).max(140),fields:briefReviewInputSchema}).strict().parse(a);
    return store.mutate(args.requestId,{name,args},async old=>{
      const p=requireProject(old,args,true);
      if(p.state.proposals.filter(v=>v.status==='pending').length>=12)throw Error('Too many pending proposals');
      const proposal=proposeBrief(p.state,args.fields,args.title,'local-agent');p.state.proposals.push(proposal);
      return {project:p,result:{proposalId:proposal.id,kind:'brief',status:'pending',revision:p.state.revision,fields:proposal.briefChanges}};
    });
  }
  if (name === "propose_commands" || name === "reply_to_feedback" || name === "register_source") {
    const common={requestId:receipt,deckId:z.string(),expectedRevision:z.number().int().positive()};
    const args=name==="propose_commands" ? z.object({...common,title:z.string().trim().min(1).max(140),commands:semanticCommandsSchema,feedbackIds:z.array(z.string()).max(12).default([])}).strict().parse(a)
      : name==="reply_to_feedback" ? z.object({...common,commentId:z.string(),text:z.string().trim().min(1).max(2000),proposalId:z.string().optional()}).strict().parse(a)
      : z.object({...common,name:z.string().trim().min(1).max(140),contentType:z.enum(["image/png","image/jpeg","text/csv","application/json","text/plain","text/markdown"]),base64:z.string().min(4).max(6_666_668).regex(/^[A-Za-z0-9+/]*={0,2}$/)}).strict().parse(a);
    return store.mutate(args.requestId,{name,args},async old=> {
      const p=requireProject(old,args,true);
      if("commands" in args) {
        if(p.state.proposals.filter(v=>v.status==="pending").length>=12)throw new Error("Too many pending proposals");
        if(args.feedbackIds.some(id=>!p.state.comments.some(c=>c.id===id && !c.replyTo)))throw new Error("Feedback is outside project");
        const changes=compileCommands(p.state.doc,args.commands);assertEditDesign(p.state.doc,changes);
        const proposal=propose(p.state,changes,args.title,"local-agent");
        proposal.feedbackIds=args.feedbackIds;
        p.state.proposals.push(proposal);
        return {project:p,result:{proposalId:proposal.id,status:"pending",revision:p.state.revision}};
      }
      if("commentId" in args) {
        const parent=p.state.comments.find(c=>c.id===args.commentId && !c.replyTo);
        if(!parent)throw new Error("Feedback is outside project");
        const proposal=args.proposalId ? p.state.proposals.find(v=>v.id===args.proposalId) : null;
        if(args.proposalId && (!proposal || !proposal.changes.some(v=>v.slideId===parent.slideId)))throw new Error("Proposal does not address this slide");
        if(p.state.comments.length>=300)throw new Error("Too many comments");
        const comment={id:uid(),slideId:parent.slideId,replyTo:parent.id,text:args.text,proposalId:args.proposalId,author:"local-agent",createdAt:new Date().toISOString(),resolved:false,...(parent.anchor?{anchor:parent.anchor}:{})};
        p.state.comments.push(comment);
        return {project:p,result:{commentId:comment.id,revision:p.state.revision}};
      }
      if(args.contentType.startsWith("image/"))return {project:p,result:await registerImage(store,p,args)};
      const bytes=Buffer.from(args.base64,"base64");
      if(bytes.length>600000)throw Error("Text source limit is 600 KB");
      if(bytes.toString("base64")!==args.base64)throw new Error("Invalid base64");
      if(args.contentType==="image/png" && !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error("Invalid PNG signature");
      if(args.contentType==="image/jpeg" && !(bytes[0]===255 && bytes[1]===216 && bytes[2]===255))throw new Error("Invalid JPEG signature");
      if(p.state.sources.length>=100)throw new Error("Too many sources");
      const sha256=await store.writeMaterial(bytes), existing=p.state.sources.find(s=>s.sha256===sha256);
      if(existing)return {project:p,result:{sourceId:existing.id,sha256,revision:p.state.revision}};
      const source={id:`src-${sha256}`,sha256,name:args.name,contentType:args.contentType,kind:args.contentType.startsWith("image/")?"image" as const:"text" as const,createdAt:new Date().toISOString(),excerpt:args.contentType.startsWith("image/")?"":bytes.toString("utf8").slice(0,1500)};
      p.state.sources.push(source);
      return {project:p,result:{sourceId:source.id,sha256,revision:p.state.revision}};
    });
  }
  if (name === "propose_changes" || name === "add_comment") {
    const common = {
      requestId: receipt,
      deckId: z.string(),
      expectedRevision: z.number().int().positive(),
    };
    const args =
      name === "propose_changes"
        ? z
            .object({
              ...common,
              title: z.string().max(140),
              changes: z
                .array(
                  z
                    .object({ slideId: z.string(), after: slideSchema })
                    .strict(),
                )
                .min(1)
                .max(40),
            })
            .strict()
            .parse(a)
        : z
            .object({
              ...common,
              slideId: z.string(),
              text: z.string().min(1).max(2000),
              elementId: z.string().min(1).max(80).optional(),
            })
            .strict()
            .parse(a);
    return store.mutate(args.requestId, { name, args }, async (old) => {
      const p = requireProject(old, args, true);
      let result: unknown;
      if ("changes" in args) {
        assertEditDesign(p.state.doc,args.changes);
        if (
          p.state.proposals.filter((x) => x.status === "pending").length >= 12
        )
          throw new Error("Too many pending proposals");
        const proposal = propose(
          p.state,
          args.changes,
          args.title,
          "local-agent",
        );
        p.state.proposals.push(proposal);
        result = {
          proposalId: proposal.id,
          revision: p.state.revision,
          status: "pending",
        };
      } else {
        if (!p.state.doc.slides.some((s) => s.id === args.slideId))
          throw new Error("Slide is outside project");
        if (p.state.comments.length >= 300)
          throw new Error("Too many comments");
        const comment = {
          id: uid(),
          slideId: args.slideId,
          text: args.text,
          author: "local-agent",
          createdAt: new Date().toISOString(),
          resolved: false,
          anchor:commentAnchor(p.state,args.slideId,args.elementId),
        };
        p.state.comments.push(comment);
        result = { commentId: comment.id, revision: p.state.revision };
      }
      return { project: p, result };
    });
  }
  const p = requireProject(await store.read(), a, name === "export_deck" || name === "export_handoff");
  if(name==='list_exports'){
    const args=z.object({deckId:z.string(),cursor:z.string().uuid().optional()}).strict().parse(a);
    return store.listExportArtifacts(args.cursor);
  }
  if(name==='get_export_artifact'){
    const args=z.object({deckId:z.string(),artifactId:z.string().uuid()}).strict().parse(a),manifest=await store.readExportManifest(args.artifactId);
    return {manifest,...(store.documentId?{downloadPath:`/api/export-artifacts?documentId=${store.documentId}&artifactId=${manifest.id}&part=file`,manifestPath:`/api/export-artifacts?documentId=${store.documentId}&artifactId=${manifest.id}&part=manifest`}:{path:resolve(store.root,'exports',manifest.id,`presentation.${manifest.output.format}`),manifestPath:resolve(store.root,'exports',manifest.id,'manifest.json')})};
  }
  if(name==="export_handoff"){
    z.object({deckId:z.string(),expectedRevision:z.number().int().positive()}).strict().parse(a);
    const materials=[];
    for(const source of p.state.sources){
      const bytes=await store.readFile(materialPath(source.sha256),5_000_000);
      if(createHash("sha256").update(bytes).digest("hex")!==source.sha256)throw new Error("Source hash mismatch");
      materials.push({id:source.id,name:source.name,contentType:source.contentType,base64:bytes.toString("base64"),...(source.image?{image:source.image}:{})});
    }
    const bytes=Buffer.from(JSON.stringify({format:"lanka-handoff/v1",doc:p.state.doc,materials,briefing:p.briefing}));
    if(bytes.length>450000)throw new Error("Cloud JSON import is limited to 450 KB; use separately uploaded materials for larger projects");
    const path=await store.writeExport("lanka-handoff.json",bytes);
    return {path,revision:p.state.revision,editorUrl:null,status:"upload_required",instructions:"In Lanka: create presentation → JSON → upload this file. Import creates a private saved cloud copy with a permanent editorUrl. Local and cloud copies are not live-synced."};
  }
  if (name === "lint_deck")
    return {
      revision: p.state.revision,
      issues: lintDoc(p.state.doc),
      narrative: inspectNarrative(p.state.doc),
      designReview: designReview(p.state.doc),
      overflowSlides: p.state.doc.slides
        .filter(
          (s, i) =>
            scene(s, p.state.doc.brand, i, p.state.doc.slides.length, p.state.doc.design).overflow,
        )
        .map((s) => s.id),
    };
  if (name === "export_deck") {
    const args = z
      .object({
        deckId: z.string(),
        expectedRevision: z.number().int().positive(),
        format: z.enum(["pptx", "pdf"]),
      })
      .strict()
      .parse(a);
    const {bytes: _bytes, ...result} = await renderProjectExport(store, p, args.format);
    return {...result,...(store.documentId?{downloadPath:`/api/exports?documentId=${store.documentId}&key=${encodeURIComponent(result.path)}`}:{})};
  }
  throw new Error("Unknown tool");
}
