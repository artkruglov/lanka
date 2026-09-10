import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
/** Private fixture credentials remain in this closure, never in evidence output. */
export async function prepareDocumentSourceRestore({tenant,post,get,rpc}){
 const base='/api/organizations/'+tenant,documentId=randomUUID(),sources=[];
 for(const name of ['selected.md','unselected.md']){
  const bytes=Buffer.from('Материал для восстановления: '+name+'\nГорода сохраняют знания.');
  const r=await post(base+'/source-intakes',{requestId:randomUUID(),name,base64:bytes.toString('base64')});assert.equal(r.status,200);sources.push({...(await r.json()),bytes});
 }
 const created=await post(base+'/library',{requestId:documentId,command:{action:'create_document',title:'Источники после восстановления',profile:'focus-v3',empty:true,folderId:null,sources:sources.map(s=>({id:s.id,sha256:s.sha256}))}});assert.equal(created.status,200);
 const path=base+'/documents/'+documentId,preview=await get(path+'/agent-delegations?sourcePreview=1');assert.equal(preview.status,200);const snapshot=await preview.json(),selected=snapshot.items.find(s=>s.id===sources[0].id);
 const keys=[];
 for(const [name,consent] of [['Selected source',true],['No source',false],['Revoked source',true]]){
  const secret=randomBytes(32).toString('hex'),r=await post(path+'/agent-delegations',{action:'issue',request:{requestId:randomUUID(),secret,name,capability:'read',minutes:60,...(consent?{expectedRevision:snapshot.revision,documentSources:[{id:selected.id,sha256:selected.sha256,contentHash:selected.contentHash,acceptPartial:false}]}:{})}});assert.equal(r.status,200);keys.push({...(await r.json()),secret});
 }
 assert.equal((await post(path+'/agent-delegations',{action:'revoke',id:keys[2].id})).status,200);
 const value=r=>{assert.equal(r.status,200);assert.ok(r.body.result&&!r.body.result.isError,JSON.stringify(r.body));return JSON.parse(r.body.result.content[0].text);};
 const denied=r=>assert.ok([401,403,404].includes(r.status)||r.body.error||r.body.result?.isError);
 const check=async()=>{
  const call=(key,name,args={})=>rpc(documentId,key.secret,name,args);
  assert.deepEqual(value(await call(keys[0],'lanka_list_document_sources')).items,[selected]);
  assert.deepEqual(value(await call(keys[0],'lanka_get_document_source',{id:selected.id})),{revision:snapshot.revision,...selected});
  denied(await call(keys[0],'lanka_get_document_source',{id:sources[1].id}));
  assert.deepEqual(value(await call(keys[1],'lanka_list_document_sources')).items,[]);
  denied(await call(keys[1],'lanka_get_document_source',{id:selected.id}));denied(await call(keys[2],'lanka_list_document_sources'));
  for(const source of sources){const r=await get(path+'/sources?id='+source.id);assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),source.sha256);}
  return {selectedTextExact:true,originalBytesExact:true,unselectedSourceDenied:true,otherKeyDenied:true,revokedKeyDenied:true};
 };
 await check();return {check,documentId};
}
