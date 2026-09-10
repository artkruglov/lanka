import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { userInfo, homedir } from "node:os";
import { randomUUID } from "node:crypto";
const exec=promisify(execFile);
const root=resolve(import.meta.dirname,"../work/agent-chat"),configPath=join(root,"config.json");
await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
const data=join(root,"postgres"),socket=join(root,"socket");
await mkdir(socket,{recursive:true,mode:0o700});await chmod(socket,0o700);
let pgctl;
try {pgctl=(await exec("which",["pg_ctl"])).stdout.trim();}
catch {
  for(const candidate of ["/opt/homebrew/opt/postgresql@16/bin/pg_ctl","/usr/local/opt/postgresql@16/bin/pg_ctl"])
    try {await access(candidate);pgctl=candidate;break;}catch {}
}
if(!pgctl)throw new Error("Install PostgreSQL 16+ and make pg_ctl available before enabling local chat.");
const bin=dirname(pgctl);
// launchd omits locale variables; an explicit portable locale avoids macOS
// locale discovery starting threads inside the PostgreSQL postmaster.
const postgresEnv={...process.env,LC_ALL:'C',LANG:'C'};
try {await access(join(data,"PG_VERSION"));}
catch {
  await exec(join(bin,"initdb"),["-D",data,"-A","trust","--no-locale","-E","UTF8"],{maxBuffer:50000,env:postgresEnv});
  await writeFile(join(data,"postgresql.auto.conf"),`listen_addresses = ''\nunix_socket_directories = '${socket.replaceAll("'","''")}'\nunix_socket_permissions = 0700\nport = 55437\n`);
}
try {await exec(pgctl,["-D",data,"status"]);}
catch {await exec(pgctl,["-D",data,"-l",join(root,"postgres.log"),"start","-w"],{timeout:30000,env:postgresEnv});}
const connectionArgs=["-h",socket,"-p","55437"];
const exists=await exec(join(bin,"psql"),[...connectionArgs,"-d","postgres","-Atc","SELECT 1 FROM pg_database WHERE datname='lanka_chat'"]);
if(exists.stdout.trim()!=="1")await exec(join(bin,"createdb"),[...connectionArgs,"lanka_chat"]);
try {JSON.parse(await readFile(configPath,"utf8"));}
catch(e) {
  if(e.code!=="ENOENT")throw e;
  const command=(await exec("which",["codex"])).stdout.trim();
  await writeFile(configPath,JSON.stringify({format:"lanka-local-chat/v1",workspaceRoot:resolve(import.meta.dirname,"../work/local-library"),connection:{host:socket,port:55437,database:"lanka_chat",user:userInfo().username},tenantId:randomUUID(),ownerId:randomUUID(),runtimeRoot:join(root,"sessions"),command,codexHome:process.env.CODEX_HOME||join(homedir(),".codex"),runtimeMode:'dedicated'},null,2),{mode:0o600});
}
process.stdout.write("Local chat storage is ready. PostgreSQL accepts this user's private socket only.\n");
