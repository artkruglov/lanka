import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRepository } from "../../lib/project/repository";
import type { FolderProject } from "../../lib/project/package";
import { projectExportBytes } from "./export";
import { acceptProposal, validateDoc, validateReferences } from "../../lib/domain/model";
import {designReview} from '../../lib/domain/design-review';

// launchd and MCP subprocesses do not necessarily inherit the interactive shell's
// Homebrew PATH. Resolve this server dependency without accepting model paths.
async function popplerCommand() {
  const dirs=(process.env.PATH||"").split(":").filter(p=>p.startsWith("/"));
  if(process.platform==="darwin")dirs.push("/opt/homebrew/bin","/usr/local/bin");
  for(const dir of [...new Set(dirs)]) {
    const path=join(dir,"pdftoppm");
    try {await access(path,constants.X_OK);return path;}catch {}
  }
  throw new Error("Slide preview requires Poppler (pdftoppm) on the Lanka server.");
}

/** Rasterize the canonical PDF, including fonts and original slide numbering.
 * Poppler is an explicit local runtime dependency. Paths are never model inputs.
 */
export async function previewSlides(store:Pick<ProjectRepository,'readFile'>,saved:FolderProject,ids:string[],proposalId?:string) {
  const p=structuredClone(saved);
  if(proposalId) {
    const proposal=p.state.proposals.find(v=>v.id===proposalId&&v.status==="pending");
    if(!proposal)throw new Error("Предложение закрыто или недоступно.");
    // Apply the same remaining-change conflict rules as human acceptance, only to this copy.
    acceptProposal(p.state,proposalId,proposal.changes.filter(c=>c.status==="pending").map(c=>c.id));
    p.state.doc=validateDoc(p.state.doc);validateReferences(p.state);
  }
  const indices=ids.map(id=>p.state.doc.slides.findIndex(s=>s.id===id));
  if(indices.some(i=>i<0))throw new Error("Slide is outside this document");
  const rendered=await rasterizePdfPages(await projectExportBytes(store,p,"pdf"),indices);
  const images=rendered.map((image,i)=>({slideId:ids[i],number:image.number,mimeType:"image/png",data:image.bytes.toString("base64")}));
  const review=designReview(p.state.doc);
  return {revision:p.state.revision,design:p.state.doc.design,renderedFrom:"canonical-pdf",view:proposalId?"proposal":"saved",proposalId:proposalId??null,composition:review.composition,designIssues:review.issues.filter(i=>!i.slideId||ids.includes(i.slideId)),images};
}

/** Render already frozen PDF bytes, without regenerating the document between formats. */
export async function rasterizePdfPages(pdfBytes:Uint8Array,indices:number[],maxBytes=600000){
 if(indices.length>40||indices.some(i=>!Number.isInteger(i)||i<0||i>=40)||maxBytes<1||maxBytes>40_000_000)throw Error('Invalid preview bounds');
  const renderer=await popplerCommand();
  const directory=await mkdtemp(join(tmpdir(),"lanka-preview-"));
  try {
    const pdf=join(directory,"deck.pdf");
    await writeFile(pdf,pdfBytes,{mode:0o600});
    const images=[];let total=0;
    for(const [i,index] of indices.entries()) {
      const prefix=join(directory,String(i));
      try {
        await promisify(execFile)(renderer,["-f",String(index+1),"-l",String(index+1),"-scale-to-x","1200","-scale-to-y","675","-singlefile","-png",pdf,prefix],{timeout:20000,maxBuffer:64000});
      } catch(e) {
        if((e as NodeJS.ErrnoException).code==="ENOENT")throw new Error("Slide preview requires Poppler (pdftoppm) on the Lanka server.");
        throw new Error("Slide preview could not be rendered within its resource limit.");
      }
      const bytes=await readFile(prefix+".png");total+=bytes.length;
      if(total>maxBytes)throw new Error("Preview response is too large. Request one slide at a time.");
      images.push({number:index+1,bytes});
    }
    return images;
  } finally {await rm(directory,{recursive:true,force:true});}
}
