const readNames=['lanka_list_document_sources','lanka_get_document_source','lanka_get_workspace_context','lanka_list_documents','lanka_get_document_view','lanka_get_shared_comments','lanka_get_edit_context','lanka_preview_proposal','lanka_get_template_reference','lanka_list_source_intakes','lanka_get_source_intake','lanka_preview_creation','lanka_list_library'];
const modes={discuss:[],propose:['lanka_propose_commands','lanka_propose_draft'],comment:['lanka_comment','lanka_set_comment_status'],create:['lanka_create_document','lanka_upload_source','lanka_copy_shared_document'],organize:['lanka_manage_library']};
const documentNames=new Set(['lanka_list_document_sources','lanka_get_document_source','lanka_get_document_view','lanka_get_shared_comments','lanka_get_edit_context','lanka_preview_proposal','lanka_propose_commands','lanka_propose_draft','lanka_comment','lanka_set_comment_status']);
/** Model-facing facade: lifecycle and chat replies belong to the worker, never the model. */
export class ScopedBridgeTools {
 constructor({client,task,mode,documentId,awaitRunning,onResult}){
  if(!modes[mode]||!['sessionId','messageId','executionId'].every(k=>/^[a-f0-9-]{36}$/.test(task?.[k]??''))||documentId&&!/^[a-f0-9-]{36}$/.test(documentId)||typeof awaitRunning!=='function')throw Error('Invalid worker scope');
  this.client=client;this.task=structuredClone(task);this.mode=mode;this.documentId=documentId;this.awaitRunning=awaitRunning;this.catalog=null;this.onResult=onResult;
 }
 async tools(signal){
  const remote=await this.client.tools(signal),allowed=new Set([...readNames,...modes[this.mode]]),seen=new Set();
  this.catalog=remote.filter(t=>allowed.has(t.name)).map(t=>{
   if(seen.has(t.name)||t.inputSchema?.type!=='object'||!t.inputSchema.properties)throw Error('Invalid model tool catalog');seen.add(t.name);
   const tool=structuredClone(t);delete tool.inputSchema.properties.task;tool.inputSchema.required=(tool.inputSchema.required??[]).filter(k=>k!=='task');
   if(this.documentId&&documentNames.has(tool.name)){delete tool.inputSchema.properties.documentId;tool.inputSchema.required=tool.inputSchema.required.filter(k=>k!=='documentId');}
   tool.description+=' The worker supplies the immutable task address and any fixed document scope. Do not supply task or override that document. Runtime lifecycle and final chat replies are handled by the worker.';
   return tool;
  });return structuredClone(this.catalog);
 }
 async call(name,args={},signal){
  if(!this.catalog)throw Error('Discover the model tools first');
  if(!this.catalog.some(t=>t.name===name)||!args||typeof args!=='object'||Array.isArray(args)||'task' in args)throw Error('Tool call outside worker scope');
  const input=structuredClone(args),write=modes[this.mode].includes(name);
  if(this.documentId&&documentNames.has(name)){if('documentId' in input&&input.documentId!==this.documentId)throw Error('Document outside worker scope');input.documentId=this.documentId;}
  if(write){await this.awaitRunning(signal);if(signal?.aborted)throw Error('Execution interrupted');input.task=structuredClone(this.task);}
  const result=await this.client.call(name,input,signal);if(write)await this.onResult?.(name,input,result);return result;
 }
}
