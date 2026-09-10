import {CodexAppServer} from './app-server.mjs';
import {CompanionFault} from './companion-faults.mjs';
/** Read-only preflight. Never use this cancellation boundary around a model turn or a write. */
export async function companionReadSession(c,work,{signal,timeoutMs=60000,openServer=options=>new CodexAppServer(options)}={}){
 if(signal?.aborted)throw new CompanionFault('READ_CANCELLED');
 const server=openServer({command:c.command,codexHome:c.codexHome,cwd:c.cwd,inheritApiKey:false,configOverrides:['project_doc_max_bytes=0','features.memories=false',`sqlite_home=${JSON.stringify(c.codexHome)}`]});
 let ended=false,reason,timer,rejectStop;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;});
 const stop=code=>{if(ended||reason)return;reason=new CompanionFault(code);rejectStop(reason);};
 const abort=()=>stop('READ_CANCELLED');
 const read=async(method,...args)=>{if(reason)throw reason;if(ended)throw new CompanionFault('READ_CANCELLED');const value=await Promise.race([server[method](...args),stopped]);if(reason)throw reason;return value;};
 signal?.addEventListener('abort',abort,{once:true});
 timer=setTimeout(()=>stop('READ_TIMEOUT'),timeoutMs);
 try{
  if(signal?.aborted)abort();
  const reader={initialize:()=>read('initialize'),request:(method,args)=>{if(!['config/read','account/read','model/list','thread/read'].includes(method))throw new CompanionFault('PROTOCOL');return read('request',method,args);}};
  return await Promise.race([Promise.resolve().then(()=>work(reader)),stopped]);
 }finally{ended=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);server.close();}
}
