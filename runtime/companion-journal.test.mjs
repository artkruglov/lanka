import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {openCompanionJournal} from './companion-journal.mjs';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'lanka-journal-'));await chmod(dir,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));return {path:join(dir,'task.json'),initial:{sessionId:randomUUID(),messageId:randomUUID()}};}
test('durable startup intent survives reopen and cannot be launched again',async t=>{
 const {path,initial}=await fixture(t);let j=await openCompanionJournal(path,initial);const id=j.snapshot().executionId;
 await j.advance('claim_pending');await j.advance('claimed');await j.advance('start_pending');await j.close();
 j=await openCompanionJournal(path,initial);assert.equal(j.snapshot().executionId,id);assert.equal(j.snapshot().phase,'start_pending');await assert.rejects(j.advance('start_pending'));await j.advance('unknown',{reason:'Startup outcome requires reconciliation'});await assert.rejects(j.advance('claimed'));await j.close();
});
test('exclusive ownership prevents another worker, and immutable scope cannot be replaced',async t=>{
 const {path,initial}=await fixture(t),j=await openCompanionJournal(path,initial);await assert.rejects(openCompanionJournal(path,initial),{code:'EEXIST'});await assert.rejects(j.advance('claim_pending',{executionId:randomUUID()}));assert.equal(j.snapshot().phase,'received');await j.close();await assert.rejects(openCompanionJournal(path,{...initial,messageId:randomUUID()}),/mismatch/);
});
test('answer bytes and request ID survive restart before reply acknowledgement',async t=>{
 const {path,initial}=await fixture(t);let j=await openCompanionJournal(path,initial);await j.advance('claim_pending');await j.advance('claimed');await j.advance('start_pending');await assert.rejects(j.advance('running'),/identity/);await j.advance('running',{nativeThreadId:'thread',nativeTurnId:'turn'});
 await assert.rejects(j.advance('terminal',{nativeTurnId:'other'}),/immutable/);
 const reply='Сохранено предложение',replyRequestId=randomUUID();await j.advance('answer_pending',{reply,replyRequestId});await j.close();j=await openCompanionJournal(path,initial);assert.equal(j.snapshot().reply,reply);assert.equal(j.snapshot().replyRequestId,replyRequestId);await j.advance('replied');await j.advance('terminal');await assert.rejects(j.advance('running'));await j.close();
});
test('queued transitions persist in order and close waits for pending writes',async t=>{
 const {path,initial}=await fixture(t),j=await openCompanionJournal(path,initial);const a=j.advance('claim_pending'),b=j.advance('claimed');await j.close();await Promise.all([a,b]);const saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.phase,'claimed');assert.equal(saved.sequence,2);await assert.rejects(j.advance('start_pending'),/closed/);
});
test('public checkpoint directory is refused',async t=>{const {path,initial}=await fixture(t);await chmod(join(path,'..'),0o755);await assert.rejects(openCompanionJournal(path,initial),/Private/);});

test('process crash keeps the task claim locked instead of automatic takeover',async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events');const {path,initial}=await fixture(t);
 const child=spawn(process.execPath,['--input-type=module','-e',`import {openCompanionJournal} from ${JSON.stringify(new URL('./companion-journal.mjs',import.meta.url).href)};const j=await openCompanionJournal(process.argv[1],JSON.parse(process.argv[2]));await j.advance('claim_pending');await j.advance('claimed');await j.advance('start_pending');process.stdout.write('ready');setInterval(()=>{},1000);`,path,JSON.stringify(initial)],{stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill('SIGKILL'));await once(child.stdout,'data');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 assert.equal(JSON.parse(await readFile(path,'utf8')).phase,'start_pending');await assert.rejects(openCompanionJournal(path,initial),{code:'EEXIST'});
});
