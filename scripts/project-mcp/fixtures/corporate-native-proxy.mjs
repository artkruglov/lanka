// Acceptance-only stdio adapter for a disposable, loopback corporate MCP server.
// A private config holds the temporary key; it is never printed or put in argv.
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createInterface} from 'node:readline';
const file=process.argv[2];
if(!file||!isAbsolute(file))throw Error('Private configuration required');
const config=JSON.parse(await readFile(file,'utf8')),url=new URL(config.url);
if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||!/^\/mcp\/organizations\/[a-f0-9-]{36}\/documents\/[a-f0-9-]{36}$/.test(url.pathname)||!/^([a-f0-9]{64})$/.test(config.secret)||!Array.isArray(config.tools)||config.tools.some(t=>typeof t!=='string'||!/^lanka_[a-z_]+$/.test(t)))throw Error('Invalid test MCP configuration');
const allowed=new Set(config.tools);
const reader=createInterface({input:process.stdin});
for await(const line of reader){
 let input;
 try{
  if(Buffer.byteLength(line)>1_000_000)throw Error();input=JSON.parse(line);
  if(input.id===undefined)continue;
  if(!['initialize','ping','tools/list','tools/call'].includes(input.method))throw Error();
  if(input.method==='tools/call'&&!allowed.has(input.params?.name))throw Error();
  const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+config.secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify(input),signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error();
  const output=await response.json();
  if(input.method==='tools/list'&&output.result?.tools)output.result.tools=output.result.tools.filter(t=>allowed.has(t.name));
  process.stdout.write(JSON.stringify(output)+'\n');
 }catch{
  if(input?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:input.id,error:{code:-32603,message:'Test MCP request failed; no automatic retry was made.'}})+'\n');
 }
}
