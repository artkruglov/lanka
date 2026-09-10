import { createHash } from "node:crypto";
import { creationProfile } from "../agents/creation-profile";
import { fromMarkdown } from "../domain/intake";
import { initialState, validateDoc, validateReferences, changedContent, type Slide } from "../domain/model";
import { canonicalJson } from "../domain/canonical-json";
import { designReview } from "../domain/design-review";
import { scene } from "../domain/scene";
import type { FolderProject } from "./package";
import { resolveBriefing, briefFromBriefing } from "../domain/briefing";
const hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");

export async function emptyDraft(id:string,title:string,profile:"focus-v2"|"focus-v3"):Promise<FolderProject> {
  const design=await creationProfile(profile),doc=fromMarkdown("",title);
  doc.id=id;doc.design=design.design;doc.brand=design.brand;
  const canonical=validateDoc(doc);
  return {format:"lanka-project/v1",title,state:initialState(canonical),receipts:[],draftShell:{revision:1,hash:hash(canonical)}};
}

export function canPopulateDraft(p:FolderProject) {
  return !!p.draftShell&&p.draftShell.revision===p.state.revision&&p.draftShell.hash===hash(p.state.doc)
    &&(!p.draftShell.sourceHash||p.draftShell.sourceHash===hash(p.state.sources))
    &&p.state.comments.length===0&&p.state.proposals.length===0&&p.state.approvedRevision===null;
}

export function populateDraft(p:FolderProject,slides:Slide[],briefingInput?:unknown,title?:string) {
  if(!canPopulateDraft(p))throw new Error("Заготовка уже изменена или обсуждается. Сохранённая работа защищена; создайте новую пустую презентацию.");
  if(title!==undefined&&!p.draftShell?.allowTitle)throw new Error("Название автора защищено. Не заменяйте его при заполнении.");
  const doc=validateDoc({...p.state.doc,slides,...(title!==undefined?{title}:{})});
  assertCreationDesign(doc);
  const result=structuredClone(p);
  if(briefingInput!==undefined) {
    if(doc.brief||p.briefing)throw new Error("В заготовке уже сохранён контекст. Не заменяйте его при заполнении слайдов.");
    result.briefing=resolveBriefing(briefingInput);
    doc.brief=briefFromBriefing(result.briefing);
  }
  result.title=doc.title;result.state.doc=doc;changedContent(result.state);delete result.draftShell;
  validateReferences(result.state);return result;
}

/** Shared quality gate for structured browser, local-agent and corporate-agent creation. */
export function creationDesignProblems(doc:import('../domain/model').DeckDoc){
  const location=(id:string)=>`Слайд ${doc.slides.findIndex(s=>s.id===id)+1} (${id})`;
  const problems=designReview(doc).issues.map(i=>i.slideId?`${location(i.slideId)}: ${i.message}`:i.message);
  for(const [i,s] of doc.slides.entries())if(scene(s,doc.brand,i,doc.slides.length,doc.design).overflow)problems.push(`${location(s.id)}: композиция не вмещает содержание.`);
  if(doc.design==="focus-v3"&&doc.slides[0].layout==="cover"&&!doc.slides[0].title.includes("\n"))problems.push("Обложке Focus 3 нужна акцентная часть после переноса строки.");
  return problems;
}
export function assertCreationDesign(doc:import('../domain/model').DeckDoc){
 const problems=creationDesignProblems(doc);if(problems.length)throw new Error("Исправьте оформление перед заполнением: "+problems.join(" "));
}

/** Discussion and rejected alternatives do not destroy an otherwise untouched shell. */
export function canProposeDraft(p:FolderProject){
 return !!p.draftShell&&p.draftShell.revision===p.state.revision&&p.draftShell.hash===hash(p.state.doc)&&p.state.doc.slides.length===1&&p.state.approvedRevision===null;
}
