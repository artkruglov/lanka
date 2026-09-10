import {ProjectClient} from './project-mcp/client.mjs';
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

// Isolated browser acceptance: never connect to the user's server or stored documents.
await mkdir('out',{recursive:true});
const artifacts=await mkdtemp(resolve('out/brief-browser-'));
const root=await realpath(await mkdtemp(join(tmpdir(),'lanka-presentation-browser-')));
let browser,child;
let exited=Promise.resolve();
try{
 child=spawn(process.execPath,[resolve('.project-runtime/web.mjs'),'--workspace',root,'--port','0'],{stdio:['ignore','pipe','pipe']});
 exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
 const origin=await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(Error('Test server startup timed out')),30000);
   let output='';
   const done=(error,value)=>{clearTimeout(timeout);error?reject(error):resolve(value);};
   child.once('error',()=>done(Error('Test server failed to start')));
   child.once('exit',()=>done(Error('Test server stopped')));
   child.stdout.on('data',chunk=>{output=(output+chunk).slice(-16000);const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)done(null,match[0]);});
   child.stderr.on('data',()=>{});
 });
const cookie=(await fetch(origin,{signal:AbortSignal.timeout(10000)})).headers.get('set-cookie').split(';')[0];const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
const call=async(path,body)=>{const r=await fetch(origin+path,{headers,signal:AbortSignal.timeout(10000),...(body?{method:'POST',body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Error(JSON.stringify(value));return value;};
const created=await call('/api/library',{requestId:randomUUID(),command:{action:'create_document',title:'Замысел: проверка',folderId:null,profile:'focus-v3'}});
const path='/api/project?documentId='+created.id,before=await call(path);
browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(origin+'/documents/'+created.id,{waitUntil:'networkidle'});
await page.getByText('Замысел презентации',{exact:true}).click();
const fields=page.locator('.project-brief textarea');
const values=['Руководители продуктовых команд','Выбрать направление следующего квартала','Рост должен опираться на проверенные данные'];
for(let i=0;i<3;i++){assert.equal(await fields.nth(i).getAttribute('maxlength'),i===0?'400':'800');await fields.nth(i).fill(values[i]);}
let saved;for(let i=0;i<100;i++){saved=await call(path);if(saved.state.doc.brief?.keyMessage===values[2])break;await new Promise(r=>setTimeout(r,100));}
assert.deepEqual(saved.state.doc.brief,{audience:values[0],decision:values[1],keyMessage:values[2],origins:{audience:'user',decision:'user',keyMessage:'user'}});
const expected=structuredClone(before.state.doc);expected.brief=saved.state.doc.brief;assert.deepEqual(saved.state.doc,expected);
await page.reload({waitUntil:'networkidle'});await page.getByText('Замысел презентации',{exact:true}).click();
for(let i=0;i<3;i++)assert.equal(await fields.nth(i).inputValue(),values[i]);
await page.screenshot({path:join(artifacts,'brief-desktop.png'),fullPage:false});assert.deepEqual(errors,[]);
const connection=await (await page.request.get(origin+'/api/connection?documentId='+created.id)).json();const rootIndex=connection.args.indexOf('--root');assert.ok(rootIndex>=0);
const client=new ProjectClient(connection.args[rootIndex+1]);try{await client.call('initialize',{});assert.deepEqual((await client.tool('get_project')).state.doc.brief,saved.state.doc.brief);}finally{client.close();}

const proposalClient=new ProjectClient(connection.args[rootIndex+1]);
try{
 await proposalClient.call('initialize',{});
 const request={requestId:randomUUID(),deckId:saved.state.doc.id,expectedRevision:saved.state.revision,title:'Уточнить замысел',fields:{audience:'Совет директоров',decision:'Подтвердить инвестиции'}};
 const proposed=await proposalClient.tool('propose_brief',request);assert.equal(proposed.kind,'brief');
 assert.deepEqual(await proposalClient.tool('propose_brief',request),proposed);
 assert.deepEqual((await proposalClient.tool('get_project')).state.doc,saved.state.doc);
 await assert.rejects(()=>proposalClient.tool('propose_brief',{...request,requestId:randomUUID(),deckId:randomUUID()}));
 await assert.rejects(()=>proposalClient.tool('propose_brief',{...request,requestId:randomUUID(),expectedRevision:saved.state.revision+1}));
 await assert.rejects(()=>proposalClient.tool('propose_brief',{...request,requestId:randomUUID(),fields:{origins:{audience:'user'}}}));
 assert.equal((await proposalClient.tool('get_project')).state.proposals.length,1);
}finally{proposalClient.close();}
await page.reload({waitUntil:'networkidle'});await page.getByRole('tab',{name:/^Изменения/}).click();
const review=page.getByRole('region',{name:'Предложение замысла',exact:true});await review.waitFor();
await review.getByRole('button',{name:'Принять: Для кого',exact:true}).click();
await review.getByText('Принято',{exact:true}).waitFor();
await review.getByRole('button',{name:'Отклонить оставшиеся ответы',exact:true}).click();
await page.getByRole('heading',{name:'Нет изменений, ожидающих решения',exact:true}).waitFor();
const accepted=(await call(path)).state.doc;assert.deepEqual(accepted.slides,saved.state.doc.slides);assert.equal(accepted.brief.audience,'Совет директоров');assert.equal(accepted.brief.decision,values[1]);
await page.reload({waitUntil:'networkidle'});await page.getByRole('tab',{name:/^Изменения/}).click();
await page.locator('.proposal-board details > summary').filter({hasText:'История рассмотренных предложений'}).click();
await review.getByText('Отклонено',{exact:true}).waitFor();
await page.screenshot({path:join(artifacts,'brief-review-history.png'),fullPage:false});
const base=await call(path),concurrentClient=new ProjectClient(connection.args[rootIndex+1]);let concurrentProposal;
try{await concurrentClient.call('initialize',{});concurrentProposal=await concurrentClient.tool('propose_brief',{requestId:randomUUID(),deckId:base.state.doc.id,expectedRevision:base.state.revision,title:'Проверка конкурентного замысла',fields:{decision:'Решение агента',keyMessage:'Независимая мысль агента'}});}finally{concurrentClient.close();}
const other=await browser.newPage({viewport:{width:1440,height:1000}});
await other.goto(origin+'/documents/'+created.id,{waitUntil:'networkidle'});await other.getByText('Замысел презентации',{exact:true}).click();await other.locator('.project-brief textarea').nth(1).fill('Решение автора во второй вкладке');
let manual;for(let i=0;i<100;i++){manual=await call(path);if(manual.state.doc.brief.decision==='Решение автора во второй вкладке')break;await new Promise(r=>setTimeout(r,100));}assert.equal(manual.state.doc.brief.decision,'Решение автора во второй вкладке');await other.close();
await page.reload({waitUntil:'networkidle'});await page.getByRole('tab',{name:/^Изменения/}).click();
const conflictReview=review.filter({hasText:'Проверка конкурентного замысла'});await conflictReview.waitFor();await conflictReview.getByRole('status').filter({hasText:'Решение автора во второй вкладке'}).waitFor();
assert.equal(await conflictReview.getByRole('button',{name:'Принять: Какое решение нужно',exact:true}).isDisabled(),true);
assert.equal(await conflictReview.getByRole('button',{name:'Принять: Главная мысль',exact:true}).isEnabled(),true);
assert.equal(await conflictReview.getByRole('button',{name:'Принять оставшиеся ответы',exact:true}).isDisabled(),true);
// Server must reject a bypass of the disabled UI atomically.
const pending=manual.state.proposals.find(p=>p.id===concurrentProposal.proposalId);
const denied=await fetch(origin+path,{method:'POST',headers,body:JSON.stringify({requestId:randomUUID(),deckId:manual.state.doc.id,expectedRevision:manual.state.revision,command:{action:'accept',proposalId:pending.id,changeIds:pending.briefChanges.map(c=>c.id)}})});
assert.equal(denied.ok,false);assert.match(JSON.stringify(await denied.json()),/Конфликт/);assert.deepEqual((await call(path)).state,manual.state);
await page.setViewportSize({width:390,height:844});for(const button of await conflictReview.locator('.brief-review-actions button').all())assert.ok(await button.evaluate(e=>e.scrollWidth<=e.clientWidth),'Brief action label must fit');await page.screenshot({path:join(artifacts,'brief-conflict-mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth));
await conflictReview.getByRole('button',{name:'Принять: Главная мысль',exact:true}).click();await conflictReview.getByText('Принято',{exact:true}).waitFor();await conflictReview.getByRole('button',{name:'Отклонить оставшиеся ответы',exact:true}).click();
await page.getByRole('heading',{name:'Нет изменений, ожидающих решения',exact:true}).waitFor();
const final=await call(path),expectedFinal=structuredClone(manual.state.doc);expectedFinal.brief.keyMessage='Независимая мысль агента';expectedFinal.brief.origins.keyMessage='user';assert.deepEqual(final.state.doc,expectedFinal);assert.equal(final.state.proposals.find(p=>p.id===pending.id).status,'closed');assert.deepEqual(errors,[]);
await writeFile(join(artifacts,'result.json'),JSON.stringify({realFileBackend:true,briefAutosaved:true,seededDomainProposal:false,agentProposalTransport:true,proposalReplayIdempotent:true,wrongDocumentAndRevisionDenied:true,browserPartialAcceptance:true,concurrentBrowserEditPreserved:true,serverConflictAtomic:true,independentFieldAccepted:true,mobileConflictNoOverflow:true,browserRejection:true,reviewHistoryReload:true,realStdioMcpRead:true,reloadRestored:true,onlyBriefChanged:true,originsUser:true,errors},null,2));console.log(artifacts);
}finally{await browser?.close();if(child){child.kill('SIGTERM');const t=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(t);}await rm(root,{recursive:true,force:true});}
