import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('native acceptance proxy filters tools and never forwards a disallowed call',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lanka-native-proxy-')),secret=randomBytes(32).toString('hex'),calls=[];
 const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const call=JSON.parse(raw);calls.push(call.method);assert.equal(req.headers.authorization,'Bearer '+secret);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result:call.method==='tools/list'?{tools:[{name:'lanka_get_colleague_review'},{name:'lanka_unrelated'}]}:{content:[{type:'text',text:'{"ok":true}'}]}}));});
 let child;
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const config=join(root,'private.json');await writeFile(config,JSON.stringify({url:`http://127.0.0.1:${server.address().port}/mcp/organizations/${randomUUID()}/documents/${randomUUID()}`,secret,tools:['lanka_get_colleague_review']}),{mode:0o600});
  child=spawn(process.execPath,[resolve('scripts/project-mcp/fixtures/corporate-native-proxy.mjs'),config],{stdio:['pipe','pipe','pipe']});let output='',errors='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>errors+=d);const exited=once(child,'exit');
  child.stdin.end([{id:1,method:'tools/list'},{id:2,method:'tools/call',params:{name:'lanka_unrelated'}},{id:3,method:'tools/call',params:{name:'lanka_get_colleague_review'}}].map(v=>JSON.stringify({jsonrpc:'2.0',...v})+'\n').join(''));
  const [code]=await exited;assert.equal(code,0);const replies=output.trim().split('\n').map(JSON.parse);assert.deepEqual(replies[0].result.tools.map(t=>t.name),['lanka_get_colleague_review']);assert.ok(replies[1].error);assert.ok(replies[2].result);assert.deepEqual(calls,['tools/list','tools/call']);assert.equal((output+errors).includes(secret),false);
 }finally{child?.kill();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
