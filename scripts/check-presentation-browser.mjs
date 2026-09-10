import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

// Isolated browser acceptance: never connect to the user's server or stored documents.
await mkdir('out',{recursive:true});
const artifacts=await mkdtemp(resolve('out/presentation-browser-'));
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
const created=await call('/api/library',{requestId:randomUUID(),command:{action:'create_document',title:'Проверка выступления',folderId:null,profile:'focus-v3'}});
const path='/api/project?documentId='+created.id,project=await call(path),doc=structuredClone(project.state.doc);
doc.slides=[1,2,3].map(n=>({...structuredClone(doc.slides[0]),id:randomUUID(),title:'Шаг '+n,notes:'Личные заметки выступающего'}));
await call(path,{requestId:randomUUID(),deckId:doc.id,expectedRevision:project.state.revision,command:{action:'save',editorContract:'lanka-editor/3',doc}});
const saved=await call(path);
browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.goto(origin+'/documents/'+created.id,{waitUntil:'networkidle'});
await page.getByRole('button',{name:'Слайд 2: Шаг 2',exact:true}).click();
const show=page.getByRole('button',{name:'Показать',exact:true});await show.click();
const dialog=page.getByRole('dialog',{name:'Показ презентации',exact:true});await dialog.waitFor();
assert.equal(await dialog.evaluate(e=>e.matches(':modal')),true);
assert.match(await dialog.locator('nav').textContent(),/2 \/ 3/);
assert.equal(await dialog.getByText('Личные заметки выступающего',{exact:true}).count(),0);
for(const [key,counter] of [['End','3 / 3'],['Home','1 / 3'],['PageDown','2 / 3'],['ArrowRight','3 / 3'],['PageUp','2 / 3']]) {
 await page.keyboard.press(key);await dialog.getByText(counter,{exact:true}).waitFor();
}
for(let i=0;i<6;i++){await page.keyboard.press('Tab');assert.ok(await dialog.evaluate(e=>e.contains(document.activeElement)));}
await page.screenshot({path:join(artifacts,'presentation-desktop.png'),fullPage:false});
await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.ok(await show.evaluate(e=>e===document.activeElement));
await show.click();await dialog.getByText('2 / 3',{exact:true}).waitFor();
await page.setViewportSize({width:390,height:844});
assert.ok(await dialog.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}));
await page.screenshot({path:join(artifacts,'presentation-mobile.png'),fullPage:false});
await dialog.getByRole('button',{name:'Следующий слайд',exact:true}).click();
await dialog.getByText('3 / 3',{exact:true}).waitFor();
await dialog.getByRole('button',{name:'Закрыть · Esc',exact:true}).click();
assert.deepEqual((await call(path)).state,saved.state);assert.deepEqual(errors,[]);
await page.reload({waitUntil:'networkidle'});await show.click();await dialog.getByText('3 / 3',{exact:true}).waitFor();
await dialog.getByRole('button',{name:'Закрыть · Esc',exact:true}).click();
// Restore by stable slide identity, even if a colleague reorders the document.
const reordered=structuredClone(saved.state.doc);reordered.slides=[reordered.slides[2],reordered.slides[0],reordered.slides[1]];
await call(path,{requestId:randomUUID(),deckId:doc.id,expectedRevision:saved.state.revision,command:{action:'save',editorContract:'lanka-editor/3',doc:reordered}});
await page.reload({waitUntil:'networkidle'});await show.click();await dialog.getByText('1 / 3',{exact:true}).waitFor();
assert.ok((await dialog.textContent()).includes('Шаг 3'));
await dialog.getByRole('button',{name:'Закрыть · Esc',exact:true}).click();
assert.deepEqual((await call(path)).state.doc,reordered);
const currentProject=await call(path),removed=structuredClone(reordered);removed.slides.shift();
await call(path,{requestId:randomUUID(),deckId:doc.id,expectedRevision:currentProject.state.revision,command:{action:'save',editorContract:'lanka-editor/3',doc:removed}});
await page.reload({waitUntil:'networkidle'});await show.click();await dialog.getByText('1 / 2',{exact:true}).waitFor();
assert.ok((await dialog.textContent()).includes('Шаг 1'));
await dialog.getByRole('button',{name:'Закрыть · Esc',exact:true}).click();
assert.deepEqual((await call(path)).state.doc,removed);


await writeFile(join(artifacts,'result.json'),JSON.stringify({realFileBackend:true,startsAtSelectedSlide:true,resumesAtLastSlide:true,reloadRestoresStableSlide:true,deletedSlideFallsBack:true,keyboardNavigation:true,focusTrapped:true,focusRestored:true,privateNotesAbsent:true,documentUnchanged:true,errors},null,2));
console.log(artifacts);
}finally{await browser?.close();if(child){child.kill('SIGTERM');const t=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(t);}await rm(root,{recursive:true,force:true});}
