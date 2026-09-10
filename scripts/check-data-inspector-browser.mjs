import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

// Isolated browser acceptance: never connect to the user's server or stored documents.
await mkdir('out',{recursive:true});
const artifacts=await mkdtemp(resolve('out/data-inspector-'));
const root=await realpath(await mkdtemp(join(tmpdir(),'lanka-data-inspector-')));
let browser,child,result;
let exited=Promise.resolve();
try{
 child=spawn(process.execPath,[resolve('.project-runtime/web.mjs'),'--workspace',root,'--port','0'],{env:{...process.env,LANKA_UI_REFRESH:'1'},stdio:['ignore','pipe','pipe']});
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

 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);const errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
 for(const kind of ['chart','table']){
  const created=await call('/api/library',{requestId:randomUUID(),command:{action:'create_document',title:'Проверка панели: '+kind,folderId:null,profile:'focus-v3'}});
  const path='/api/project?documentId='+created.id,initial=await call(path),doc=structuredClone(initial.state.doc);
  const data=kind==='chart'?{seriesId:'series',unit:'ч',rows:[{id:'a',label:'А',value:20},{id:'b',label:'Б',value:40}]}:{columns:[{id:'label',label:'Группа',role:'key',valueType:'text',unit:''},{id:'value',label:'Значение',role:'number',valueType:'number',unit:'ч'}],rows:[{id:'a',cells:{label:'А',value:20}},{id:'b',cells:{label:'Б',value:40}}]};
  if(kind==='table'){for(const id of ['plan','fact']){data.columns.push({id,label:id==='plan'?'План':'Факт',role:'number',valueType:'number',unit:'ч'});for(const row of data.rows)row.cells[id]=30;}}
  doc.slides[0].canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'heading',kind:'text',x:100,y:40,w:1400,h:100,text:'Данные отдела',size:48,color:'#242421',font:'sans',bold:true,lineHeight:1.2},{id:'data',kind,x:100,y:200,w:1400,h:600,style:{brand:doc.brand,design:'focus-v3',layoutVersion:'focus-v3-data-2'},data}];
  await call(path,{requestId:randomUUID(),deckId:doc.id,expectedRevision:initial.state.revision,command:{action:'save',editorContract:'lanka-editor/3',doc}});
  const read=async()=>(await call(path)).state.doc;
  const waitDoc=async expected=>{for(let n=0;n<100;n++){if(JSON.stringify(await read())===JSON.stringify(expected))return;await new Promise(r=>setTimeout(r,100));}assert.deepEqual(await read(),expected);};
  const selectData=async()=>{await page.locator('.canvas-layer-list summary').click();await page.getByLabel('Выбрать объект',{exact:true}).selectOption('data');};
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/documents/'+created.id);await selectData();
  await page.locator('.object-inspector').getByRole('button',{name:'Данные…',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:kind==='chart'?'Данные диаграммы':'Данные таблицы',exact:true});await dialog.waitFor();
  const field=dialog.getByLabel(kind==='chart'?'Значение строки 1':'Значение, строка 1',{exact:true});await field.fill('25');assert.deepEqual(await read(),doc);
  await page.screenshot({path:join(artifacts,kind+'-desktop.png'),fullPage:true});
  await dialog.getByRole('button',{name:'Применить',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const expected=structuredClone(doc),object=expected.slides[0].canvas.find(e=>e.id==='data');if(kind==='chart')object.data.rows[0].value=25;else object.data.rows[0].cells.value=25;
  await waitDoc(expected);await page.reload();await selectData();await page.setViewportSize({width:390,height:844});
  await page.getByRole('navigation',{name:'Панели редактора',exact:true}).getByRole('button',{name:'Содержание',exact:true}).click();
  const open=page.locator('.object-inspector').getByRole('button',{name:'Данные…',exact:true});await open.click();await dialog.waitFor();assert.equal(await field.inputValue(),'25');
  const fields=await dialog.locator('fieldset').boundingBox(),preview=await dialog.locator('.data-editor-preview').boundingBox();assert.ok(fields.y<preview.y,'Mobile form places editable data before preview');
  if(kind==='chart'){assert.equal(await dialog.locator('.data-editor-scroll').evaluate(el=>el.scrollWidth>el.clientWidth),false,'Chart row actions fit without sideways scrolling');}
  const assertFooter=async()=>{const box=await dialog.getByRole('button',{name:'Применить',exact:true}).boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=844,'Apply remains within mobile viewport');};
  await assertFooter();
  if(kind==='table'){
   const grid=dialog.getByRole('region',{name:'Ячейки данных',exact:true});await grid.focus();await page.keyboard.press('End');await page.keyboard.press('ArrowRight');
   await grid.evaluate(el=>{el.scrollLeft=el.scrollWidth;});
   const lastCell=dialog.getByLabel('Факт, строка 1',{exact:true});await lastCell.focus();assert.equal(await lastCell.inputValue(),'30');
   const cellBox=await lastCell.boundingBox(),gridBox=await grid.boundingBox();assert.ok(cellBox.x>=gridBox.x&&cellBox.x+cellBox.width<=gridBox.x+gridBox.width,'Last column reachable inside scroll region');
   await dialog.locator('.data-editor-body').evaluate(el=>{el.scrollTop=el.scrollHeight;});await assertFooter();
   await page.screenshot({path:join(artifacts,'table-mobile-footer.png'),fullPage:true});
  }
  await field.fill('77');await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.deepEqual(await read(),expected);
  await open.click();await dialog.waitFor();assert.equal(await field.inputValue(),'77');
  await page.screenshot({path:join(artifacts,kind+'-mobile-draft.png'),fullPage:true});
  await dialog.getByRole('button',{name:'Применить',exact:true}).click();await dialog.waitFor({state:'hidden'});
  if(kind==='chart')object.data.rows[0].value=77;else object.data.rows[0].cells.value=77;
  await waitDoc(expected);assert.equal(await page.locator('.project-columns').getAttribute('data-panel'),'slides');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:join(artifacts,kind+'-mobile-applied.png'),fullPage:true});
  checks.push({kind,sidebarOpensData:true,previewDoesNotSave:true,onlySelectedValueChanged:true,reload:true,mobileDraftSurvivesClose:true,applyReturnsToSlide:true});
 }
 assert.deepEqual(errors,[]);result={realFileBackend:true,checks,pageErrors:errors};
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
console.log('Data inspector checks passed. Evidence: '+artifacts);
