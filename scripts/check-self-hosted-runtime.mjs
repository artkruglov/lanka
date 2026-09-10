import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
const image='postgres:16-bookworm@sha256:bb3e1a57e5407e0a5280b4211980a5e537f4abd234a87014ac979849a78dd825';
const root=await mkdtemp(join(tmpdir(),'lanka-role-'));const name='lanka-role-qa-'+Date.now();let pool,app;
function run(cmd,args){const r=spawnSync(cmd,args,{encoding:'utf8'});if(r.status!==0)throw Error(cmd+' failed: '+r.stderr);return r.stdout.trim();}
try{
 run(process.execPath,['deploy/self-hosted/configure.mjs',join(root,'private')]);
 run('docker',['run','-d','--name',name,'--mount',`type=bind,src=${root}/private/database-password,dst=/run/secrets/password,readonly`,'-e','POSTGRES_PASSWORD_FILE=/run/secrets/password','-e','POSTGRES_USER=lanka_operator','-e','POSTGRES_DB=lanka','-p','127.0.0.1::5432',image]);
 const port=Number(run('docker',['port',name,'5432/tcp']).split(':').at(-1));
 const op=JSON.parse(await readFile(join(root,'private/operator.json'),'utf8'));op.connection.host='127.0.0.1';op.connection.port=port;
 const config=join(root,'operator.json');await writeFile(config,JSON.stringify(op),{mode:0o600});
 pool=new Pool({...op.connection,connectionTimeoutMillis:1000});
 let ready=false;for(let n=0;n<40;n++){try{await pool.query('SELECT 1');ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}assert.ok(ready);
 run(process.execPath,['.project-runtime/migrate-self-hosted.mjs','--config',config]);
 const grant=()=>run(process.execPath,['.project-runtime/grant-self-hosted-runtime.mjs','--config',config,'--request',join(root,'private/runtime-role.json')]);grant();grant();
 const role=JSON.parse(await readFile(join(root,'private/runtime-role.json'),'utf8'));
 app=new Pool({...op.connection,user:role.role,password:role.password});
 assert.equal((await app.query('SELECT count(*)::int AS n FROM lanka.schema_migrations')).rows[0].n,28);
 for(const sql of ["DELETE FROM lanka.schema_migrations WHERE false",'CREATE TABLE lanka.forbidden(id int)','CREATE ROLE forbidden'])await assert.rejects(app.query(sql),e=>e.code==='42501');
 await pool.query('CREATE TABLE lanka.runtime_probe(id int PRIMARY KEY)');
 await app.query('INSERT INTO lanka.runtime_probe VALUES(1)');await app.query('UPDATE lanka.runtime_probe SET id=2');await app.query('DELETE FROM lanka.runtime_probe');
 await pool.query('ALTER TABLE lanka.runtime_probe OWNER TO lanka_app');
 const rejected=spawnSync(process.execPath,['.project-runtime/grant-self-hosted-runtime.mjs','--config',config,'--request',join(root,'private/runtime-role.json')],{encoding:'utf8'});assert.equal(rejected.status,1);
 const result={checkedAt:new Date().toISOString(),isolatedContainer:true,migrations:28,repeatGrant:true,registryWriteDenied:true,schemaCreateDenied:true,roleCreateDenied:true,futureTableDml:true,ownedObjectsRejected:true};
 await mkdir('out',{recursive:true});
 await writeFile('out/self-hosted-role-result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await app?.end();await pool?.end();spawnSync('docker',['rm','-f','-v',name],{encoding:'utf8'});await rm(root,{recursive:true,force:true});}
