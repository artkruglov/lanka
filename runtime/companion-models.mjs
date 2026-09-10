import {CompanionFault} from './companion-faults.mjs';
/** Resolve the explicitly selected native model; never substitute the catalog default. */
export async function requireCompanionModel(server,model){
 if(typeof model!=='string'||!model.trim()||model.length>200)throw new CompanionFault('CONFIGURATION');
 let cursor;const seen=new Set();
 for(let page=0;page<20;page++){
  const result=await server.request('model/list',{limit:100,includeHidden:true,...(cursor?{cursor}:{})});
  if(!Array.isArray(result?.data)||result.data.length>100)throw new CompanionFault('PROTOCOL');
  const selected=result.data.find(item=>item?.model===model);
  if(selected)return {model:selected.model};
  if(result.nextCursor===null||result.nextCursor===undefined)throw new CompanionFault('MODEL_UNAVAILABLE');
  if(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor.length>2000||seen.has(result.nextCursor))throw new CompanionFault('PROTOCOL');
  cursor=result.nextCursor;seen.add(cursor);
 }
 throw new CompanionFault('PROTOCOL');
}

import {companionReadSession} from './companion-read-session.mjs';
export async function listCompanionModels(c,options={}){
 return companionReadSession(c,async server=>{
  await server.initialize();if((await server.request('config/read',{includeLayers:false})).config.sqlite_home!==c.codexHome)throw new CompanionFault('CONFIGURATION');
  if(!(await server.request('account/read',{refreshToken:false})).account)throw new CompanionFault('AUTH_REQUIRED');
  let cursor;const seen=new Set(),models=new Map();
  for(let page=0;page<20;page++){
   const result=await server.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
   if(!Array.isArray(result?.data)||result.data.length>100)throw new CompanionFault('PROTOCOL');
   for(const item of result.data){if(typeof item?.model!=='string'||!item.model||item.model.length>200)throw new CompanionFault('PROTOCOL');if(item.hidden!==true)models.set(item.model,{model:item.model,displayName:typeof item.displayName==='string'?item.displayName.slice(0,200):item.model});}
   if(result.nextCursor===null||result.nextCursor===undefined)return [...models.values()];
   if(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor.length>2000||seen.has(result.nextCursor))throw new CompanionFault('PROTOCOL');cursor=result.nextCursor;seen.add(cursor);
  }
  throw new CompanionFault('PROTOCOL');
 },options);
}
