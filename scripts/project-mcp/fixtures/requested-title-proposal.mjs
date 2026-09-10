import {isDeepStrictEqual} from 'node:util';
/** Acceptance-fixture authorization only. Never used by the product runner. */
export function isRequestedTitleProposal(item,{slideId,revision,text}){
 if(item?.server!=='lanka_document'||item.tool!=='lanka_propose_commands')return false;
 let a=item.arguments;try{if(typeof a==='string')a=JSON.parse(a);}catch{return false;}
 return !!a&&typeof a==='object'&&!Array.isArray(a)&&
  Object.keys(a).every(k=>['requestId','expectedRevision','title','commands','feedbackIds'].includes(k))&&
  typeof a.requestId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(a.requestId)&&
  typeof a.title==='string'&&a.title.trim().length>0&&a.title.length<=140&&a.expectedRevision===revision&&
  (a.feedbackIds===undefined||isDeepStrictEqual(a.feedbackIds,[]))&&
  isDeepStrictEqual(a.commands,[{op:'edit_text',slideId,elementId:'title',value:{text}}]);
}
