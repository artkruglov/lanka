import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import {spawn} from 'node:child_process';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const args=process.argv.slice(2);
assert.ok(args.length===0||(args.length===1&&args[0]==='--lost-upload-response'),'Unknown browser check option');
const loseUploadResponse=args.includes('--lost-upload-response');

// Isolated browser acceptance: never connect to the user's server or stored documents.
await mkdir('out',{recursive:true});
const artifacts=await mkdtemp(resolve('out/editor-browser-'));
const root=await realpath(await mkdtemp(join(tmpdir(),'lanka-editor-browser-')));
let browser,child,result;
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
const created=await call('/api/library',{requestId:randomUUID(),command:{action:'create_document',title:'Проверка слоёв · изолированный документ',folderId:null,profile:'focus-v3'}});
const projectPath='/api/project?documentId='+created.id,project=await call(projectPath),before=project.state.doc;
const current=structuredClone(before);current.slides[0].notes='Заметки сохраняются';current.slides[0].canvas=[{id:'layer-background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'layer-title',kind:'text',text:'Текст поверх фигуры',x:150,y:200,w:900,h:150,color:'#15202B',font:'sans',size:60,bold:true,lineHeight:1.2},{id:'layer-box',kind:'rect',x:130,y:180,w:950,h:190,color:'#99CCEE'}];
await call(projectPath,{requestId:randomUUID(),deckId:before.id,expectedRevision:1,command:{action:'save',editorContract:'lanka-editor/3',doc:current}});
const f={origin,cookie,documentId:created.id,current};
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(e.message));
 const read=async()=>{const r=await fetch(f.origin+'/api/project?documentId='+f.documentId,{headers:{Cookie:f.cookie},signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return r.json();};
 const waitDoc=async expected=>{for(let i=0;i<100;i++){const p=await read();if(JSON.stringify(p.state.doc)===JSON.stringify(expected))return p.state.revision;await new Promise(r=>setTimeout(r,100));}assert.deepEqual((await read()).state.doc,expected);};
 const openArrangement=async()=>{if(await page.locator('body').getAttribute('data-ui')==='refresh')await page.getByRole('button',{name:'Расположение и действия объекта',exact:true}).click();};
 const chooseObject=async id=>{const picker=page.getByLabel('Выбрать объект',{exact:true});if(await page.locator('body').getAttribute('data-ui')==='refresh'&&!await picker.isVisible())await page.locator('.canvas-layer-list summary').click();await picker.selectOption(id);};
 await page.goto(f.origin+'/documents/'+f.documentId);
 await chooseObject('layer-box');
 const align=page.getByLabel('Выровнять объект по слайду',{exact:true});await openArrangement();await align.selectOption('center');
 const expected=structuredClone(f.current);expected.slides[0].canvas.find(e=>e.id==='layer-box').x=325;
 const first=await waitDoc(expected);
 await page.getByRole('button',{name:'Отменить правку',exact:true}).click();await waitDoc(f.current);
 await page.getByRole('button',{name:'Повторить правку',exact:true}).click();const redone=await waitDoc(expected);
 await page.reload();await chooseObject('layer-box');
 await openArrangement();await align.selectOption('middle');expected.slides[0].canvas.find(e=>e.id==='layer-box').y=355;const finalRevision=await waitDoc(expected);
 await page.screenshot({path:join(artifacts,'desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 const toolbar=page.getByRole('toolbar',{name:'Объекты слайда',exact:true});
 assert.equal(await toolbar.isVisible(),false);
 const compactTop=(await page.locator('.canvas-edit-surface').boundingBox()).y;
 await page.getByRole('button',{name:'＋ Добавить и выбрать объект',exact:true}).click();assert.equal(await toolbar.isVisible(),true);
 const expandedTop=(await page.locator('.canvas-edit-surface').boundingBox()).y;assert.ok(expandedTop-compactTop>60);
 await chooseObject('layer-title');
 await page.getByRole('button',{name:'Скрыть инструменты',exact:true}).click();assert.equal(await toolbar.isVisible(),false);
 if(await page.locator('body').getAttribute('data-ui')==='refresh'){
  await page.getByRole('navigation',{name:'Панели редактора',exact:true}).getByRole('button',{name:'Содержание',exact:true}).click();
  await page.locator('.object-inspector .canvas-properties').waitFor({state:'visible'});
  await page.screenshot({path:join(artifacts,'mobile-object-inspector.png'),fullPage:true});
 }
 assert.equal(await page.getByRole('button',{name:'Редактировать текст на слайде',exact:true}).isVisible(),true);
 await page.getByRole('button',{name:'Редактировать текст на слайде',exact:true}).click();
 assert.equal(await page.locator('.project-columns').getAttribute('data-panel'),'slides');
 const input=page.getByRole('textbox',{name:'Текст объекта на слайде',exact:true});
 const editedText='Текст изменён на слайде';
 await input.fill(editedText);
 expected.slides[0].canvas.find(e=>e.id==='layer-title').text=editedText;
 const textRevision=await waitDoc(expected);
 await page.getByRole('button',{name:'Готово',exact:true}).click();
 await page.reload();
 await page.getByRole('button',{name:'＋ Добавить и выбрать объект',exact:true}).click();
 await chooseObject('layer-title');
 await page.getByRole('button',{name:'Скрыть инструменты',exact:true}).click();
 await page.getByRole('button',{name:'Редактировать текст на слайде',exact:true}).click();
 assert.equal(await input.inputValue(),editedText);
 await page.screenshot({path:join(artifacts,'mobile-inline-edit.png'),fullPage:true});
 await input.fill('Этот ввод будет отменён');
 const cancelled=structuredClone(expected);cancelled.slides[0].canvas.find(e=>e.id==='layer-title').text='Этот ввод будет отменён';
 await waitDoc(cancelled);
 await input.press('Escape');
 const cancelledRevision=await waitDoc(expected);
 await page.getByRole('button',{name:'Редактировать текст на слайде',exact:true}).click();
 await input.fill('Отмена кнопкой');
 const buttonCancelled=structuredClone(expected);buttonCancelled.slides[0].canvas.find(e=>e.id==='layer-title').text='Отмена кнопкой';
 await waitDoc(buttonCancelled);
 await page.getByRole('button',{name:'Отменить ввод',exact:true}).click();
 const buttonCancelRevision=await waitDoc(expected);
 assert.equal(await input.count(),0);
 await page.screenshot({path:join(artifacts,'mobile.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});assert.equal(await toolbar.isVisible(),true);
 // New basic objects must be visible without covering existing slide content.
 for(const kind of ['text','rect']){
   await page.getByRole('button',{name:kind==='text'?'＋ Текст':'□ Фигура',exact:true}).click();
   const selector=page.getByLabel('Выбрать объект',{exact:true});
   const id=await selector.inputValue();assert.ok(id);
   if(kind==='text'){await input.fill('Дополнение без перекрытия');await page.getByRole('button',{name:'Готово',exact:true}).click();}
   let insertedProject;
   for(let i=0;i<100;i++){const current=await read();if(current.state.doc.slides[0].canvas.some(e=>e.id===id&&(kind!=='text'||e.text==='Дополнение без перекрытия'))){insertedProject=current;break;}await new Promise(r=>setTimeout(r,100));}
   assert.ok(insertedProject,'Inserted object must autosave');
   const added=insertedProject.state.doc.slides[0].canvas.find(e=>e.id===id);assert.equal(added.kind,kind);
   for(const object of expected.slides[0].canvas.slice(1))assert.ok(added.x>=object.x+object.w||added.x+added.w<=object.x||added.y>=object.y+object.h||added.y+added.h<=object.y,'Basic insertion overlaps prior content');
   const withoutAdded=structuredClone(insertedProject.state.doc);withoutAdded.slides[0].canvas=withoutAdded.slides[0].canvas.filter(e=>e.id!==id);assert.deepEqual(withoutAdded,expected);
   await page.screenshot({path:join(artifacts,'inserted-'+kind+'.png'),fullPage:true});
   await openArrangement();await page.getByRole('button',{name:'Удалить объект',exact:true}).click();await waitDoc(expected);
 }

 // Cancelling a newly added block is consistent before input and after autosave.
 for(const mode of ['immediate','empty-saved','typed-saved']){
   await page.getByRole('button',{name:'＋ Текст',exact:true}).click();
   const id=await page.getByLabel('Выбрать объект',{exact:true}).inputValue();assert.ok(id);
   if(mode==='typed-saved')await input.fill('Этот новый блок отменяется');
   if(mode!=='immediate'){
     let saved=false;for(let i=0;i<100;i++){const p=await read();if(p.state.doc.slides[0].canvas.some(e=>e.id===id&&(mode!=='typed-saved'||e.text==='Этот новый блок отменяется'))){saved=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(saved);
   }
   if(mode==='empty-saved')await page.getByRole('button',{name:'Отменить ввод',exact:true}).click();else await input.press('Escape');
   assert.equal(await input.count(),0);assert.equal(await page.getByLabel('Выбрать объект',{exact:true}).inputValue(),'');
   await waitDoc(expected);await page.reload();await waitDoc(expected);
   assert.equal(await page.getByLabel('Выбрать объект',{exact:true}).locator('option').filter({hasText:'Этот новый блок отменяется'}).count(),0);
 }
 // Simulate a second writer while the pointer is still held down.
 for(const conflicting of [false,true]){
   await chooseObject('layer-box');
   const hit=page.locator('.canvas-hit[aria-label="Объект: Фигура"]'),box=await hit.boundingBox(),surface=await page.locator('.canvas-interaction').boundingBox();assert.ok(box&&surface);
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+40,box.y+box.height/2);
   const remote=structuredClone(expected);remote.slides[0].notes=conflicting?'Коллега переместил объект':'Коллега изменил содержание';
   remote.slides[0].canvas.find(e=>e.id==='layer-title').text='Новая мысль коллеги';
   if(conflicting)remote.slides[0].canvas.find(e=>e.id==='layer-box').x+=20;
   const revision=(await read()).state.revision;
   await call(projectPath,{requestId:randomUUID(),deckId:before.id,expectedRevision:revision,command:{action:'save',editorContract:'lanka-editor/3',doc:remote}});
   // Observe receipt in the UI, not just a successful server write.
   await page.waitForFunction(note=>Array.from(document.querySelectorAll('textarea')).some(e=>e.value===note),remote.slides[0].notes);
   await page.mouse.up();
   if(conflicting){await page.getByRole('alert').filter({hasText:'Объект изменился во время перетаскивания'}).waitFor();assert.deepEqual((await read()).state.doc,remote);}
   else{
     let moved;
     for(let i=0;i<100;i++){const current=await read();if(current.state.doc.slides[0].canvas.find(e=>e.id==='layer-box').x!==325){moved=current.state.doc;break;}await new Promise(r=>setTimeout(r,100));}
     assert.ok(moved);assert.ok(Math.abs(moved.slides[0].canvas.find(e=>e.id==='layer-box').x-(325+40*1600/surface.width))<.1);
     const restored=structuredClone(moved);restored.slides[0].canvas.find(e=>e.id==='layer-box').x=325;assert.deepEqual(restored,remote);
   }
   await page.screenshot({path:join(artifacts,conflicting?'drag-conflict.png':'drag-preserves-colleague.png'),fullPage:true});
   await call(projectPath,{requestId:randomUUID(),deckId:before.id,expectedRevision:(await read()).state.revision,command:{action:'save',editorContract:'lanka-editor/3',doc:expected}});await page.reload();
 }
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'＋ Добавить и выбрать объект',exact:true}).click();
 const png=new PNG({width:240,height:120});
 for(let i=0;i<png.data.length;i+=4){png.data[i]=35;png.data[i+1]=120;png.data[i+2]=200;png.data[i+3]=255;}
 const imageBytes=PNG.sync.write(png);
 const uploadRequests=[];
 page.on('request',request=>{if(new URL(request.url()).pathname==='/api/images'&&request.method()==='POST')uploadRequests.push(request.postDataJSON());});
 let uploadResponse;
 if(loseUploadResponse){
   let resolveUpload,rejectUpload;uploadResponse=new Promise((resolve,reject)=>{resolveUpload=resolve;rejectUpload=reject;});
   let lost=false;
   await page.route(url=>url.pathname==='/api/images',async route=>{
     if(lost||route.request().method()!=='POST'){await route.continue();return;}
     lost=true;
     try{const response=await route.fetch({timeout:30000});const status=response.status();await route.abort('failed');resolveUpload(status);}catch(error){rejectUpload(error);await route.abort().catch(()=>{});}
   });
 }else uploadResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/images'&&r.request().method()==='POST').then(r=>r.status());
 await page.getByLabel('Файл изображения',{exact:true}).setInputFiles({name:'test-image.png',mimeType:'image/png',buffer:imageBytes});
 const uploadStatus=await uploadResponse;assert.equal(uploadStatus,200);
 const uploaded=await read(),image=uploaded.state.doc.slides[0].canvas.find(e=>e.kind==='image');assert.ok(image);
 for(const object of expected.slides[0].canvas.slice(1))assert.ok(image.x>=object.x+object.w||image.x+image.w<=object.x||image.y>=object.y+object.h||image.y+image.h<=object.y,'Uploaded image overlaps prior content');
 const withoutImage=structuredClone(uploaded.state.doc);withoutImage.slides[0].canvas=withoutImage.slides[0].canvas.filter(e=>e.id!==image.id);assert.deepEqual(withoutImage,expected);
 assert.equal(uploaded.state.sources.length,1);assert.equal(uploaded.state.sources[0].id,image.assetId);
 const asset=await fetch(f.origin+'/api/assets?documentId='+f.documentId+'&id='+image.assetId,{headers:{Cookie:f.cookie},signal:AbortSignal.timeout(10000)});
 assert.equal(asset.status,200);assert.deepEqual(Buffer.from(await asset.arrayBuffer()),imageBytes);
 const imageRevision=uploaded.state.revision;
 await page.reload();
 await page.getByRole('button',{name:'＋ Добавить и выбрать объект',exact:true}).click();
 await chooseObject(image.id);
 await page.getByRole('button',{name:'Скрыть инструменты',exact:true}).click();
 if(await page.locator('body').getAttribute('data-ui')==='refresh'){
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.object-inspector .canvas-image-properties').waitFor({state:'visible'});
  await page.screenshot({path:join(artifacts,'image-sidebar.png'),fullPage:true});
 }
 const targetFit=image.frame.fit==='contain'?'cover':'contain';
 await page.getByLabel('Режим изображения',{exact:true}).selectOption(targetFit);
 const imageExpected=structuredClone(uploaded.state.doc);imageExpected.slides[0].canvas.find(e=>e.id===image.id).frame.fit=targetFit;
 const imageFitRevision=await waitDoc(imageExpected);assert.ok(imageFitRevision>imageRevision,'Image fit edit must create a later saved revision');
 if(targetFit==='cover'&&await page.locator('body').getAttribute('data-ui')==='refresh'){
  const zoom=page.getByLabel('Масштаб изображения',{exact:true});assert.equal(await zoom.isVisible(),false);
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('navigation',{name:'Панели редактора',exact:true}).getByRole('button',{name:'Содержание',exact:true}).click();
  await page.locator('.object-inspector .canvas-image-properties').waitFor({state:'visible'});
  await page.getByRole('button',{name:'Кадрировать',exact:true}).click();await zoom.waitFor({state:'visible'});
  assert.equal(await page.locator('.project-columns').getAttribute('data-panel'),'slides');
  await page.screenshot({path:join(artifacts,'image-crop-controls.png'),fullPage:true});
  await page.getByRole('button',{name:'Готово: кадр',exact:true}).click();assert.equal(await zoom.isVisible(),false);
  assert.deepEqual((await read()).state.doc,imageExpected,'Opening crop controls must not modify the document');
 }

 await page.setViewportSize({width:390,height:844});
 const retryUpload=page.getByRole('button',{name:'Повторить загрузку',exact:true});
 const uploadRetryOffered=await retryUpload.isVisible();
 if(loseUploadResponse)assert.equal(uploadRetryOffered,true,'Lost response must remain recoverable after reload');
 if(uploadRetryOffered){await retryUpload.click();await retryUpload.waitFor({state:'hidden'});assert.deepEqual((await read()).state.doc,imageExpected);assert.equal((await read()).state.sources.length,1);assert.equal((await read()).state.revision,imageFitRevision);assert.equal(uploadRequests.length,2);assert.deepEqual(uploadRequests[1],uploadRequests[0]);}
 await page.screenshot({path:join(artifacts,'mobile-uploaded-image.png'),fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);assert.equal(overflow,false);assert.deepEqual(errors,[]);
 result={checkedAt:new Date().toISOString(),headless:true,injectedLostUploadResponse:loseUploadResponse,compactTop,expandedTop,spaceSaved:expandedTop-compactTop,mobileToggleAndSelection:true,desktopToolbarVisible:true,firstRevision:first,redoRevision:redone,finalRevision,textRevision,cancelledRevision,buttonCancelRevision,imageRevision,imageFitRevision,targetFit,imageUploadAndReload:true,imageSourceBytesPreserved:true,imageFitSaved:true,imageDoesNotOverlapExistingContent:true,basicInsertionDoesNotOverlapExistingContent:true,basicInsertionAndRemovalPreserveDocument:true,newTextCancellationRemovesInsertion:true,dragPreservesConcurrentContent:true,conflictingDragRefused:true,uploadRetryOffered,uploadRetryPreservedLaterEdits:uploadRetryOffered,cancelButtonRestoresTextAfterAutosave:true,escapeRestoresTextAfterAutosave:true,mobileInlineTextSavedAndReloaded:true,documentPreservedExceptSelectedCoordinatesAndText:true,undoRedoSaved:true,reload:true,mobileWidth:390,horizontalOverflow:overflow,pageErrors:errors};

}finally{
 try{await browser?.close();}finally{
   if(child){
     child.kill('SIGTERM');
     const deadline=setTimeout(()=>child.kill('SIGKILL'),5000);
     await exited;clearTimeout(deadline);
   }
   await rm(root,{recursive:true,force:true});
 }
}
assert.ok(result,'Browser scenario did not finish');
await writeFile(join(artifacts,'result.json'),JSON.stringify({...result,isolatedWorkspaceRemoved:true,testServerStopped:true},null,2)+'\n');
console.log('Editor browser checks passed. Evidence: '+artifacts);
