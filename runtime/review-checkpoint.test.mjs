import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile,symlink,realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ReviewCheckpoint} from "./review-checkpoint.mjs";
import {ProjectReviewSession} from "./project-review.mjs";

async function fixture(t){
  const dir=await realpath(await mkdtemp(join(tmpdir(),"lanka-resume-"))),root=await mkdtemp(join(dir,"project-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return {dir,root,home:join(dir,"runtime"),deckId:"deck-a",model:"configured-model"};
}
test("Checkpoint survives reopening; project, model and runtime ownership stay bound",async t=>{
  const args=await fixture(t),first=await ReviewCheckpoint.open(args);
  await first.save({threadId:"thread-a",turns:3});
  await assert.rejects(ReviewCheckpoint.open(args),/EEXIST/);
  await first.close();
  const second=await ReviewCheckpoint.open(args);
  assert.equal(second.data.threadId,"thread-a");assert.equal(second.data.turns,3);
  await second.close();
  await assert.rejects(ReviewCheckpoint.open({...args,deckId:"deck-b"}),/another project/);
  await assert.rejects(ReviewCheckpoint.open({...args,model:"another-model"}),/another project/);
  const root2=await mkdtemp(join(args.dir,"other-"));
  await assert.rejects(ReviewCheckpoint.open({...args,root:root2}),/another project/);
});
test("Runtime rejects shared-folder storage, inherited config and linked checkpoints",async t=>{
  const args=await fixture(t);
  await assert.rejects(ReviewCheckpoint.open({...args,home:join(args.root,"runtime")}),/separate/);
  const home=await mkdtemp(join(args.dir,"configured-"));
  await writeFile(join(home,"config.toml"),"unrelated config");
  await assert.rejects(ReviewCheckpoint.open({...args,home}),/empty dedicated/);
  const first=await ReviewCheckpoint.open(args);await first.close();
  const path=join(args.home,"lanka-review.json");await rm(path);
  await symlink(join(home,"config.toml"),path);
  await assert.rejects(ReviewCheckpoint.open(args),/ELOOP/);
});
test("Missing remote thread never silently starts another conversation",async t=>{
  const args=await fixture(t),checkpoint=await ReviewCheckpoint.open(args);
  try{
    await checkpoint.save({threadId:"missing-thread",turns:2});
    let started=false;
    const server={resume:async()=>{throw new Error("Not found");},start:async()=>{started=true;}};
    const client={tool:async name=>{
      assert.equal(name,"get_project");
      return {state:{doc:{id:args.deckId},comments:[{id:"comment",author:"Владелец проекта",resolved:false}],proposals:[]}};
    }};
    const session=new ProjectReviewSession({client,server,root:args.root,model:args.model,checkpoint});
    await assert.rejects(session.reviewNext(),/could not be resumed/);
    assert.equal(started,false);assert.equal(checkpoint.data.threadId,"missing-thread");assert.equal(checkpoint.data.turns,2);
  }finally{await checkpoint.close();}
});
