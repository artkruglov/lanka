import { mkdir, realpath, lstat, readdir, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";

/** Private runtime state, deliberately outside the shared document folder. */
export class ReviewCheckpoint {
  static async open({home,root,deckId,model}) {
    home=resolve(home);root=resolve(root);
    const inside=(a,b)=>{const r=relative(a,b);return r===""||(r!==".."&&!r.startsWith("../")&&!r.startsWith("/"));};
    if(inside(root,home)||inside(home,root))throw new Error("Keep runtime and project in separate directories");
    if(await realpath(root)!==root)throw new Error("Project root must be a real directory");
    await mkdir(home,{recursive:true,mode:0o700});
    if(await realpath(home)!==home||!(await lstat(home)).isDirectory())throw new Error("Runtime home must be a real directory");
    const lock=await open(resolve(home,"review-runtime.lock"),"wx",0o600);
    const store=new ReviewCheckpoint(home,lock);
    try {
      await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
      const binding={root,deckId,model:model??null};
      let fd;
      try {fd=await open(store.path,constants.O_RDONLY|constants.O_NOFOLLOW);}
      catch(e){if(e.code!=="ENOENT")throw e;}
      if(fd){
        try {
          const stat=await fd.stat();
          if(!stat.isFile()||stat.size>8192)throw new Error("Invalid review checkpoint");
          store.data=JSON.parse(await fd.readFile("utf8"));
        } finally {await fd.close();}
        const d=store.data;
        if(d.format!=="lanka-review/v1"||d.root!==binding.root||d.deckId!==binding.deckId||d.model!==binding.model||
           !(d.threadId===null||(typeof d.threadId==="string"&&d.threadId.length>0&&d.threadId.length<=200))||
           !Number.isInteger(d.turns)||d.turns<0||d.turns>20)throw new Error("Runtime belongs to another project/model or has an invalid checkpoint");
      } else {
        if((await readdir(home)).some(n=>n!=="review-runtime.lock"))throw new Error("New review requires an empty dedicated runtime home");
        store.data={format:"lanka-review/v1",...binding,threadId:null,turns:0};
        await store.save({});
      }
      return store;
    } catch(e){await store.close();throw e;}
  }
  constructor(home,lock){this.home=home;this.path=resolve(home,"lanka-review.json");this.lock=lock;}
  async save(patch){
    const next={...this.data,...patch},temp=resolve(this.home,`review-${randomUUID()}.tmp`);
    const fd=await open(temp,"wx",0o600);
    try {await fd.writeFile(JSON.stringify(next));await fd.sync();await fd.close();await rename(temp,this.path);this.data=next;}
    finally {await fd.close().catch(()=>{});await unlink(temp).catch(()=>{});}
  }
  async close(){if(!this.lock)return;await this.lock.close();this.lock=null;await unlink(resolve(this.home,"review-runtime.lock"));}
}
