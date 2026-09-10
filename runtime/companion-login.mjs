import {CodexAppServer} from './app-server.mjs';import {CompanionFault} from './companion-faults.mjs';
/** Explicit device login in the locally selected profile. Never imports Desktop credentials. */
export async function loginCompanion(c,{signal,onCode=()=>{},openServer=options=>new CodexAppServer(options),timeoutMs=600000}={}){
 const server=openServer({command:c.command,codexHome:c.codexHome,cwd:c.cwd,inheritApiKey:false,configOverrides:['project_doc_max_bytes=0','features.memories=false',`sqlite_home=${JSON.stringify(c.codexHome)}`]});
 let finished=false,loginId,timer,notify,stopped,cancel;const early=[];
 try{
  if(signal?.aborted)throw new CompanionFault('LOGIN_CANCELLED');
  await server.initialize();if((await server.request('config/read',{includeLayers:false})).config.sqlite_home!==c.codexHome)throw new CompanionFault('CONFIGURATION');
  if((await server.request('account/read',{refreshToken:false})).account)return;
  let resolve;const completed=new Promise(r=>resolve=r);
  notify=message=>{if(message.method!=='account/login/completed'||typeof message.params?.loginId!=='string'||typeof message.params.success!=='boolean')return;const event={id:message.params.loginId,success:message.params.success};if(loginId){if(event.id===loginId)resolve(event.success?'success':'failed');}else{early.push(event);if(early.length>8)early.shift();}};
  stopped=()=>resolve('failed');cancel=()=>resolve('cancelled');server.on('notification',notify);server.on('stopped',stopped);signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)throw new CompanionFault('LOGIN_CANCELLED');
  const login=await server.request('account/login/start',{type:'chatgptDeviceCode'},30000);
  if(typeof login.loginId!=='string'||!login.loginId||login.loginId.length>200)throw new CompanionFault('PROTOCOL');loginId=login.loginId;
  const url=new URL(login.verificationUrl);if(url.href!=='https://auth.openai.com/codex/device'||typeof login.userCode!=='string'||! /^[A-Z0-9-]{4,32}$/.test(login.userCode))throw new CompanionFault('PROTOCOL');
  timer=setTimeout(()=>resolve('timeout'),timeoutMs);
  const event=early.find(e=>e.id===loginId);if(event)resolve(event.success?'success':'failed');
  if(signal?.aborted)resolve('cancelled');else if(!event)onCode({url:url.href,code:login.userCode});
  const outcome=await completed;
  if(outcome!=='success'){throw new CompanionFault(outcome==='timeout'?'LOGIN_TIMEOUT':outcome==='cancelled'?'LOGIN_CANCELLED':'LOGIN_FAILED');}
  if(!(await server.request('account/read',{refreshToken:false})).account)throw new CompanionFault('LOGIN_FAILED');
  finished=true;
 }finally{clearTimeout(timer);if(notify)server.off('notification',notify);if(stopped)server.off('stopped',stopped);if(cancel)signal?.removeEventListener('abort',cancel);if(loginId&&!finished)await server.request('account/login/cancel',{loginId},5000).catch(()=>{});server.close();}
}
