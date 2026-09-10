import { createHash } from "node:crypto";
import type { FolderProject } from "../../lib/project/package";
import type { ProjectRepository } from "../../lib/project/repository";
export function feedbackView(p: FolderProject) {
  const payload={revision:p.state.revision, comments:p.state.comments, proposals:p.state.proposals.map(v=>({id:v.id,title:v.title,status:v.status,feedbackIds:v.feedbackIds || [],changes:v.changes.map(c=>({slideId:c.slideId,status:c.status}))}))};
  return {cursor:createHash("sha256").update(JSON.stringify(payload)).digest("hex"),...payload};
}
/** Long polling is bounded and returns data to the calling agent's current session. */
export async function waitForFeedback(store: ProjectRepository, deckId: string, cursor?: string, timeoutMs=20000) {
  const end=Date.now()+timeoutMs;
  while(true) {
    const p=await store.read();
    if(!p || p.state.doc.id!==deckId)throw new Error("Deck is outside this project");
    const next=feedbackView(p), changed=next.cursor!==cursor;
    if(changed || Date.now()>=end)return changed ? {...next,changed:true} : {cursor:next.cursor,revision:next.revision,changed:false};
    await new Promise(resolve=>setTimeout(resolve,Math.min(500,Math.max(1,end-Date.now()))));
  }
}
