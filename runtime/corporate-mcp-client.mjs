import {randomUUID} from 'node:crypto';
export const bridgeProtocol='2025-06-18';
export class BridgeTransportError extends Error {
 constructor(code,outcome){super(`Lanka MCP: ${code}`);this.name='BridgeTransportError';this.code=code;this.outcome=outcome;}
}
/** Lanka's stateless JSON Streamable HTTP transport. Never retries a dispatched request. */
export class CorporateMcpClient {
 #token;
 constructor({url,token,runtime=false,timeoutMs=20000,maxResponseBytes=20000000,fetchImpl=fetch}){
  const endpoint=new URL(url);
  if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^\/mcp\/organizations\/[a-f0-9-]{36}$/.test(endpoint.pathname)||!(endpoint.protocol==='https:'||endpoint.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(endpoint.hostname)))throw new BridgeTransportError('invalid_endpoint','not_sent');
  if(!/^[a-f0-9]{64}$/.test(token)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>32000000)throw new BridgeTransportError('invalid_configuration','not_sent');
  this.url=endpoint.href;this.#token=token;this.runtime=runtime;this.timeoutMs=timeoutMs;this.maxResponseBytes=maxResponseBytes;this.fetch=fetchImpl;
 }
 async request(method,params={},signal){
  if(signal?.aborted)throw new BridgeTransportError('cancelled','not_sent');
  const id=randomUUID(),payload=JSON.stringify({jsonrpc:'2.0',id,method,params});
  if(Buffer.byteLength(payload)>7000000)throw new BridgeTransportError('request_too_large','not_sent');
  const timeout=AbortSignal.timeout(this.timeoutMs),abort=signal?AbortSignal.any([signal,timeout]):timeout;
  let response;
  try{response=await this.fetch(this.url,{method:'POST',redirect:'manual',signal:abort,headers:{Authorization:'Bearer '+this.#token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':bridgeProtocol,...(this.runtime?{'Lanka-Runtime-Protocol':'1'}:{})},body:payload});}
  catch{throw new BridgeTransportError(abort.aborted?'interrupted':'network_failure','unknown');}
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new BridgeTransportError(`http_${response.status}`,[401,403,404,405,406,413,415].includes(response.status)?'rejected':'unknown');}
  if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')){await response.body?.cancel().catch(()=>{});throw new BridgeTransportError('unexpected_content_type','unknown');}
  const reader=response.body?.getReader();if(!reader)throw new BridgeTransportError('empty_response','unknown');
  const chunks=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>this.maxResponseBytes){await reader.cancel();throw new BridgeTransportError('response_too_large','unknown');}chunks.push(value);}}
  catch(e){if(e instanceof BridgeTransportError)throw e;throw new BridgeTransportError('response_interrupted','unknown');}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new BridgeTransportError('invalid_json','unknown');}
  if(!body||typeof body!=='object'||Array.isArray(body)||body.jsonrpc!=='2.0'||body.id!==id||('result' in body)===('error' in body))throw new BridgeTransportError('invalid_envelope','unknown');
  if('error' in body)throw new BridgeTransportError('rpc_rejected',[-32600,-32601,-32602].includes(body.error?.code)?'rejected':'unknown');
  return body.result;
 }
 initialize(signal){return this.request('initialize',{protocolVersion:bridgeProtocol,capabilities:{},clientInfo:{name:'lanka-companion',version:'0.1.0'}},signal);}
 call(name,args={},signal){return this.request('tools/call',{name,arguments:args},signal);}
 async tools(signal){const response=await this.request('tools/list',{},signal);if(!Array.isArray(response?.tools)||response.nextCursor)throw new BridgeTransportError('invalid_catalog','unknown');return response.tools;}
}
