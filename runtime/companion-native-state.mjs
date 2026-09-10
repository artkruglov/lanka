import {companionReadSession} from './companion-read-session.mjs';import {CompanionFault} from './companion-faults.mjs';
export function isTerminalNativeSnapshot(thread,threadId,turnId){
 const turns=thread?.turns;return thread?.id===threadId&&Array.isArray(turns)&&turns.length>0&&turns.every(t=>['completed','interrupted','failed'].includes(t?.status))&&turns.at(-1)?.id===turnId;
}
/** A read snapshot is evidence only, not a fence or authorization to restart. */
export async function inspectNativeExecution(c,state,options={}){
 if(!['nativeThreadId','nativeTurnId'].every(k=>typeof state[k]==='string'&&state[k].length>0&&state[k].length<=200))return {native:'missing_identity'};
 try{return await companionReadSession(c,async server=>{await server.initialize();if((await server.request('config/read',{includeLayers:false})).config?.sqlite_home!==c.codexHome)throw new CompanionFault('CONFIGURATION');const result=await server.request('thread/read',{threadId:state.nativeThreadId,includeTurns:true});return {native:isTerminalNativeSnapshot(result?.thread,state.nativeThreadId,state.nativeTurnId)?'terminal_snapshot':'unconfirmed'};},options);}
 catch(error){if(options.signal?.aborted)throw error;return {native:'unconfirmed'};}
}
