import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('private installation configuration separates credentials and refuses overwrite',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lanka-install-'));
 const directory=join(root,'private');
 const run=(path)=>spawnSync(process.execPath,[resolve('deploy/self-hosted/configure.mjs'),path],{encoding:'utf8'});
 try{
  const result=run(directory);assert.equal(result.status,0,result.stderr);
  assert.equal((await stat(directory)).mode&0o777,0o700);
  const json=async(name)=>JSON.parse(await readFile(join(directory,name),'utf8'));
  const operator=await json('operator.json'),app=await json('lanka.json'),role=await json('runtime-role.json');
  assert.notEqual(operator.connection.password,app.connection.password);
  assert.equal(role.password,app.connection.password);
  assert.equal((await readFile(join(directory,'database-password'),'utf8')).trim(),operator.connection.password);
  assert.equal(app.connection.user,'lanka_app');assert.equal(operator.connection.user,'lanka_operator');
  assert.equal(app.auth.origin,'https://lanka.example.invalid');
  for(const secret of [operator.connection.password,app.connection.password])assert.ok(!(result.stdout+result.stderr).includes(secret));
  const before=await readFile(join(directory,'lanka.json'),'utf8');
  assert.notEqual(run(directory).status,0);
  assert.equal(await readFile(join(directory,'lanka.json'),'utf8'),before);
  assert.notEqual(run('relative-private-directory').status,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
