import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {CorporateMcpClient,BridgeTransportError} from './corporate-mcp-client.mjs';
import {ScopedBridgeTools} from './scoped-bridge-tools.mjs';
const token='1'.repeat(64),path='/mcp/organizations/11111111-1111-4111-8111-111111111111';
async function serve(t,handler){const s=createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return 'http://127.0.0.1:'+s.address().port+path;}
const error=(code,outcome)=>e=>e instanceof BridgeTransportError&&e.code===code&&e.outcome===outcome&&!String(e).includes(token);
test('client posts bounded JSON with explicit runtime discovery and hides its credential',async t=>{
 let calls=0;const url=await serve(t,async(req,res)=>{calls++;assert.equal(req.headers.authorization,'Bearer '+token);assert.equal(req.headers['lanka-runtime-protocol'],'1');let body='';for await(const chunk of req)body+=chunk;const rpc=JSON.parse(body);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{tools:[]}}));});
 const c=new CorporateMcpClient({url,token,runtime:true});assert.equal(JSON.stringify(c).includes(token),false);assert.deepEqual(await c.tools(),[]);assert.equal(calls,1);
});
test('redirect, invalid envelope and oversized body never cause an automatic retry',async t=>{
 let calls=0;const url=await serve(t,async(req,res)=>{calls++;for await(const chunk of req){};if(calls===1){res.writeHead(307,{Location:'https://example.invalid/steal'});res.end();}else {res.writeHead(200,{'Content-Type':'application/json'});res.end(calls===2?'42':'x'.repeat(100));}});
 const c=new CorporateMcpClient({url,token,maxResponseBytes:32});await assert.rejects(()=>c.call('write',{requestId:'same'}),error('http_307','unknown'));assert.equal(calls,1);
 await assert.rejects(()=>c.call('write',{requestId:'same'}),error('invalid_envelope','unknown'));assert.equal(calls,2);await assert.rejects(()=>c.call('write',{requestId:'same'}),error('response_too_large','unknown'));assert.equal(calls,3);
});
test('timeout preserves unknown outcome, while pre-aborted and oversized calls are not sent',async t=>{
 let calls=0;const url=await serve(t,async req=>{calls++;for await(const chunk of req){};});const c=new CorporateMcpClient({url,token,timeoutMs:80});
 await assert.rejects(()=>c.call('write'),error('interrupted','unknown'));assert.equal(calls,1);
 const controller=new AbortController();controller.abort();await assert.rejects(()=>c.call('write',{},controller.signal),error('cancelled','not_sent'));await assert.rejects(()=>c.call('write',{data:'a'.repeat(7000001)}),error('request_too_large','not_sent'));assert.equal(calls,1);
});
test('remote plaintext, URL credentials, query credentials and fragments are rejected before use',()=>{
 for(const url of ['http://company.invalid'+path,'https://user:password@company.invalid'+path,'https://company.invalid'+path+'?token=x','https://company.invalid'+path+'#x'])assert.throws(()=>new CorporateMcpClient({url,token}),error('invalid_endpoint','not_sent'));
});
test('model facade fixes scope, hides runtime and reply tools, and waits for native readiness before writes',async()=>{
 const task={sessionId:'11111111-1111-4111-8111-111111111111',messageId:'22222222-2222-4222-8222-222222222222',executionId:'33333333-3333-4333-8333-333333333333'},documentId='44444444-4444-4444-8444-444444444444',calls=[];let ready;const gate=new Promise(r=>ready=r);
 const names=['lanka_propose_commands','lanka_get_document_view','lanka_reply_message','lanka_claim_execution','lanka_manage_library'];const client={tools:async()=>names.map(name=>({name,description:'Tool',inputSchema:{type:'object',properties:{task:{},documentId:{}},required:['documentId']}})),call:async(name,args)=>{calls.push({name,args});return {content:[]};}};
 const scoped=new ScopedBridgeTools({client,task,mode:'propose',documentId,awaitRunning:()=>gate}),catalog=await scoped.tools();assert.deepEqual(catalog.map(t=>t.name),names.slice(0,2));assert.equal(catalog[0].inputSchema.properties.task,undefined);assert.equal(catalog[0].inputSchema.properties.documentId,undefined);
 await assert.rejects(()=>scoped.call('lanka_reply_message',{}));await assert.rejects(()=>scoped.call('lanka_propose_commands',{task}));await assert.rejects(()=>scoped.call('lanka_propose_commands',{documentId:task.messageId}));
 const pending=scoped.call('lanka_propose_commands',{requestId:'original'});await Promise.resolve();assert.equal(calls.length,0);ready();await pending;assert.deepEqual(calls[0].args,{requestId:'original',task,documentId});
 const discussion=new ScopedBridgeTools({client,task,mode:'discuss',documentId,awaitRunning:()=>gate});assert.deepEqual((await discussion.tools()).map(t=>t.name),['lanka_get_document_view']);await assert.rejects(()=>discussion.call('lanka_propose_commands',{}));
});

test('stdio gateway injects its execution scope and cannot expose worker lifecycle or credentials',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{spawn}=await import('node:child_process'),{createInterface}=await import('node:readline');
 const dir=await mkdtemp(join(tmpdir(),'lanka-stdio-')),task={sessionId:'11111111-1111-4111-8111-111111111111',messageId:'22222222-2222-4222-8222-222222222222',executionId:'33333333-3333-4333-8333-333333333333'},documentId='44444444-4444-4444-8444-444444444444';t.after(()=>rm(dir,{recursive:true,force:true}));
 const calls=[],url=await serve(t,async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const rpc=JSON.parse(text);calls.push(rpc);let result={};if(rpc.method==='tools/list')result={tools:['lanka_propose_commands','lanka_claim_execution'].map(name=>({name,description:'Tool',inputSchema:{type:'object',properties:{documentId:{type:'string'},task:{type:'object'}},required:['documentId']}}))};if(rpc.method==='tools/call')result={content:[{type:'text',text:'accepted'}]};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));});
 const readyPath=join(dir,'ready.json'),config=join(dir,'config.json');await writeFile(config,JSON.stringify({url,token,task,mode:'propose',documentId,readyPath}),{mode:0o600});await writeFile(readyPath,JSON.stringify({executionId:task.executionId,state:'running'}),{mode:0o600});
 const child=spawn(process.execPath,[fileURLToPath(new URL('./bridge-mcp.mjs',import.meta.url)),'--config',config],{stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);t.after(()=>{child.kill();});const rows=createInterface({input:child.stdout}),pending=new Map();rows.on('line',line=>{const v=JSON.parse(line);pending.get(v.id)?.(v);pending.delete(v.id);});
 let id=0;const rpc=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error('Gateway timeout')),5000);pending.set(n,v=>{clearTimeout(timer);resolve(v);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
 assert.ok((await rpc('initialize')).result);const tools=(await rpc('tools/list')).result.tools;assert.deepEqual(tools.map(t=>t.name),['lanka_propose_commands']);
 assert.ok((await rpc('tools/call',{name:'lanka_propose_commands',arguments:{requestId:'stable'}})).result);assert.deepEqual(calls.at(-1).params.arguments,{requestId:'stable',documentId,task});
 const count=calls.length;assert.ok((await rpc('tools/call',{name:'lanka_claim_execution',arguments:{}})).error);assert.equal(calls.length,count);assert.equal(stderr.includes(token),false);
 child.stdin.end();await new Promise(r=>child.once('exit',r));
});

test('worker config requires private permissions and readiness belongs to the exact execution',async t=>{
 const {loadBridgeConfig,readyGate}=await import('./bridge-mcp.mjs'),{mkdtemp,writeFile,chmod,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
 const dir=await mkdtemp(join(tmpdir(),'lanka-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'config.json'),readyPath=join(dir,'ready.json'),task={executionId:'execution-one'};
 await writeFile(path,JSON.stringify({readyPath,task}),{mode:0o600});assert.deepEqual((await loadBridgeConfig(path)).task,task);await chmod(path,0o644);await assert.rejects(()=>loadBridgeConfig(path));
 await writeFile(readyPath,JSON.stringify({executionId:'other',state:'running'}));await assert.rejects(()=>readyGate({readyPath,task}));
 await writeFile(readyPath,JSON.stringify({executionId:task.executionId,state:'stopped'}));await assert.rejects(()=>readyGate({readyPath,task}));
 const abort=new AbortController();abort.abort();await assert.rejects(()=>readyGate({readyPath,task},abort.signal));
});

test('worker exposes consented source tools and fixes their document scope',async()=>{
 const documentId='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',task={sessionId:documentId,messageId:other,executionId:'33333333-3333-4333-8333-333333333333'},calls=[];
 const client={tools:async()=>['lanka_list_document_sources','lanka_get_document_source'].map(name=>({name,description:'Read source',inputSchema:{type:'object',properties:{documentId:{type:'string'},id:{type:'string'}},required:['documentId']}})),call:async(name,args)=>{calls.push({name,args});return {content:[]};}};
 const tools=new ScopedBridgeTools({client,task,mode:'discuss',documentId,awaitRunning:async()=>{throw Error('Read should not claim a write');}});const catalog=await tools.tools();assert.equal(catalog.length,2);assert.ok(catalog.every(t=>!t.inputSchema.properties.documentId));await tools.call('lanka_get_document_source',{id:'source'});assert.equal(calls[0].args.documentId,documentId);await assert.rejects(()=>tools.call('lanka_get_document_source',{id:'source',documentId:other}),/outside worker scope/);assert.equal(calls.length,1);
});

test('draft creation proposal is bound to the worker document and running propose task',async()=>{
 const task={sessionId:randomUUID(),messageId:randomUUID(),executionId:randomUUID()},documentId=randomUUID(),calls=[];
 const client={tools:async()=>[{name:'lanka_propose_draft',description:'Draft',inputSchema:{type:'object',properties:{documentId:{},task:{}},required:['documentId']}}],call:async(name,args)=>{calls.push({name,args});return {content:[]};}};
 let running=0;const scoped=new ScopedBridgeTools({client,task,documentId,mode:'propose',awaitRunning:async()=>{running++;}});await scoped.tools();await assert.rejects(()=>scoped.call('lanka_propose_draft',{documentId:randomUUID()}));await scoped.call('lanka_propose_draft',{requestId:randomUUID()});assert.equal(running,1);assert.equal(calls[0].args.documentId,documentId);assert.deepEqual(calls[0].args.task,task);
 const discuss=new ScopedBridgeTools({client,task,documentId,mode:'discuss',awaitRunning:async()=>{throw Error('Unexpected');}});assert.deepEqual(await discuss.tools(),[]);
});
