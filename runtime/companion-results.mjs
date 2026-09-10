import {appendFile,lstat,readFile} from 'node:fs/promises';
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
export function capturedReference(name,args,result){
 if(result?.isError||!['lanka_propose_commands','lanka_propose_draft','lanka_create_document','lanka_copy_shared_document'].includes(name))return null;
 let data;try{data=JSON.parse(result.content?.find(c=>c.type==='text')?.text);}catch{throw Error('Invalid committed result');}
 const reference=['lanka_propose_commands','lanka_propose_draft'].includes(name)?{documentId:args.documentId,revision:data.revision,proposalId:data.proposalId}:{documentId:data.id,revision:data.revision};
 if(!uuid(reference.documentId)||!Number.isSafeInteger(reference.revision)||reference.revision<1||['lanka_propose_commands','lanka_propose_draft'].includes(name)&&!uuid(reference.proposalId))throw Error('Invalid committed result reference');return reference;
}
export async function recordCapturedResult(path,executionId,name,args,result){
 const reference=capturedReference(name,args,result);if(!reference)return;
 const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.size>64000)throw Error('Private result ledger required');
 await appendFile(path,JSON.stringify({executionId,...reference})+'\n');
}
export async function readCapturedResults(path,executionId){
 const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.size>65000)throw Error('Invalid result ledger');
 const references=new Map();for(const line of (await readFile(path,'utf8')).split('\n').filter(Boolean)){
  const r=JSON.parse(line);if(r.executionId!==executionId||!uuid(r.documentId)||!Number.isSafeInteger(r.revision)||r.revision<1||r.proposalId!==undefined&&!uuid(r.proposalId))throw Error('Invalid result evidence');
  references.set(r.documentId+':'+(r.proposalId??''),{documentId:r.documentId,revision:r.revision,...(r.proposalId?{proposalId:r.proposalId}:{})});
 }
 if(references.size>8)throw Error('More than eight result cards require a separate response');return [...references.values()];
}

/** Refresh link revisions only; never changes content or the captured proposal identity. */
export async function refreshCapturedResults(references,readDocument){
 if(!Array.isArray(references)||references.length>8)throw Error('Invalid captured references');
 const reads=new Map();for(const r of references){if(!uuid(r.documentId)||!Number.isSafeInteger(r.revision)||r.revision<1||r.proposalId!==undefined&&!uuid(r.proposalId))throw Error('Invalid captured reference');if(!reads.has(r.documentId))reads.set(r.documentId,Promise.resolve().then(()=>readDocument(r.documentId)));}
 const outcomes=await Promise.allSettled([...reads.values()]);let index=0;for(const id of reads.keys()){const outcome=outcomes[index++];if(outcome.status==='rejected')throw outcome.reason;reads.set(id,outcome.value);}
 return references.map(r=>{const view=reads.get(r.documentId);if(view?.id!==r.documentId||!Number.isSafeInteger(view.revision)||view.revision<r.revision)throw Error('Current result version cannot be verified');return {...r,revision:view.revision};});
}
