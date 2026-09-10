import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

// Isolated browser acceptance: never connect to the user's server or stored documents.
await mkdir('out',{recursive:true});
const artifacts=await mkdtemp(resolve('out/chat-browser-'));
const root=await realpath(await mkdtemp(join(tmpdir(),'lanka-chat-browser-')));
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
const created=await call('/api/library',{requestId:randomUUID(),command:{action:'create_document',title:'Проверка чата · синтетические ответы',folderId:null,profile:'focus-v3'}});
const projectPath='/api/project?documentId='+created.id,project=await call(projectPath),before=project.state.doc;
const current=structuredClone(before);current.slides[0].notes='Заметки сохраняются';current.slides[0].canvas=[{id:'layer-background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'layer-title',kind:'text',text:'Текст поверх фигуры',x:150,y:200,w:900,h:150,color:'#15202B',font:'sans',size:60,bold:true,lineHeight:1.2},{id:'layer-box',kind:'rect',x:130,y:180,w:950,h:190,color:'#99CCEE'}];
await call(projectPath,{requestId:randomUUID(),deckId:before.id,expectedRevision:1,command:{action:'save',editorContract:'lanka-editor/3',doc:current}});
const f={origin,cookie,documentId:created.id,current};
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const read=async()=>{const r=await fetch(f.origin+'/api/project?documentId='+f.documentId,{headers:{Cookie:f.cookie},signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return r.json();};

 // UI-only server responses: no agent process or personal account is used.
 const sessionId=randomUUID(),proposalId=randomUUID(),selection={slideId:current.slides[0].id};
 const message=(status,proposalId=null)=>({id:randomUUID(),role:'assistant',text:'',status,mode:'edit',selection,proposalId,createdAt:new Date().toISOString()});
 let view={sessionId,cursor:1,active:null,queued:0,messages:[message('failed'),message('interrupted'),message('complete'),message('complete',proposalId),message('streaming')]};
 await page.route(url=>url.pathname==='/api/project',async route=>{
   const response=await route.fetch(),data=await response.json();await route.fulfill({response,json:{...data,chatEnabled:true}});
 });
 await page.route('**/api/v1/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   const data=path==='/api/v1/agent-connections'?{available:false,enabled:false,status:'disabled',name:'Тестовый агент',capabilities:{chat:true,streaming:true,toolMode:'native_mcp',resume:'exact'}}:path===`/api/v1/materials/${before.id}/agent-sessions`?{sessionId}:path===`/api/v1/agent-sessions/${sessionId}`?view:null;
   if(!data)errors.push('Unexpected chat API request: '+path);
   await route.fulfill({status:data?200:404,contentType:'application/json',body:JSON.stringify(data??{error:'Unexpected fixture request'})});
 });
 await page.goto(f.origin+'/documents/'+f.documentId+'?chat');
 const chat=page.getByRole('region',{name:'Обсуждение с агентом'});
 await chat.getByText('Ответ не получен. Запуск завершился с ошибкой.',{exact:true}).waitFor();
 assert.equal(await chat.getByText('Запуск остановлен до получения ответа.',{exact:true}).count(),1);
 assert.equal(await chat.getByText('Агент завершил работу без текстового ответа.',{exact:true}).count(),1);
 assert.equal(await chat.getByText('Предложение подготовлено.',{exact:true}).count(),1);
 assert.equal(await chat.getByText('Готовит ответ…',{exact:true}).count(),1);
 assert.equal(await chat.getByRole('button',{name:/Предложение правки/}).count(),1);
 const settings=chat.locator('.chat-settings-disclosure');
 const refreshed=await page.locator('body').getAttribute('data-ui')==='refresh';
 assert.equal(await settings.evaluate(e=>e.open),!refreshed);
 const draftText='Черновик остаётся при переключении панелей';
 await chat.locator('textarea').fill(draftText);
 await page.locator('.project-inspector').getByRole('button',{name:'Содержание',exact:true}).click();
 await page.locator('.project-inspector').getByRole('button',{name:'Агент',exact:true}).click();
 assert.equal(await chat.locator('textarea').inputValue(),draftText);
 await settings.locator(':scope > summary').click();
 assert.equal(await chat.locator('textarea').inputValue(),draftText);
 await settings.locator(':scope > summary').click();
 await chat.locator('textarea').fill('');
 await page.screenshot({path:join(artifacts,'desktop-chat-status.png'),fullPage:true});
 view={...view,cursor:2,messages:view.messages.map(m=>m.status==='streaming'?{...m,status:'failed'}:m)};
 await chat.getByText('Готовит ответ…',{exact:true}).waitFor({state:'hidden'});
 assert.equal(await chat.getByText('Ответ не получен. Запуск завершился с ошибкой.',{exact:true}).count(),2);
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:join(artifacts,'mobile-chat-status.png'),fullPage:true});
 const markdownText=['## План презентации','','- Введение','- Выводы','','| Период | Города | Письмо | Торговля | Управление | Источники |','| --- | --- | --- | --- | --- | --- |','| Пример | Учебный город | Учебная запись | Обмен | Правила | Материалы |','','- [x] Сценарий подготовлен','- [ ] Требуется проверка','','```text','long_identifier_'+ 'x'.repeat(180),'```'].join('\n');
 view={...view,cursor:3,messages:[...view.messages,{...message('complete'),text:markdownText}]};
 await chat.getByRole('heading',{name:'План презентации',exact:true}).waitFor();
 const table=chat.getByRole('table');assert.equal(await table.count(),1);assert.equal(await table.getByRole('columnheader').count(),6);assert.equal(await table.getByRole('cell').count(),6);
 const scroll=chat.getByRole('region',{name:'Таблица из ответа агента',exact:true});
 assert.ok(await scroll.evaluate(e=>e.scrollWidth>e.clientWidth),'Wide table must scroll within its own container');
 await scroll.scrollIntoViewIfNeeded();await scroll.focus();await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>document.querySelector('.chat-table-scroll').scrollLeft>0);
 assert.equal(await chat.getByRole('checkbox').count(),2);assert.ok(await chat.getByRole('checkbox').first().isDisabled());
 const markdown=chat.locator('.chat-markdown').last();assert.equal(await markdown.locator('pre code').count(),1);
 await page.screenshot({path:join(artifacts,'mobile-chat-markdown.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await scroll.scrollIntoViewIfNeeded();
 await page.screenshot({path:join(artifacts,'desktop-chat-markdown.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);assert.equal(overflow,false);
 // The corporate workspace chat uses the same actual editor with synthetic organization APIs.
 const tenantId=randomUUID(),userId=randomUUID(),corporatePath=`/organizations/${tenantId}/documents/${f.documentId}`,apiBase=`/api/organizations/${tenantId}`,workspaceSession={id:randomUUID(),title:'Проверка Markdown через MCP',folderResourceId:null};
 let pendingDenied=false;
 const snapshot=await read();
 const publicationId=randomUUID(),publicationBase=apiBase+'/documents/'+f.documentId+'/publications';let catalogMode=false,catalogDenied=false;const olderPublicationId=randomUUID();let published=false,publishCalls=[],dropPublish=true,publicationDenied=false,copyCalls=[];
 const publicationPreview={id:publicationId,hash:'a'.repeat(64),sourceRevision:2,audienceEpoch:'1',expiresAt:new Date(Date.now()+600000).toISOString(),document:{...snapshot.state.doc,title:'История городов',slides:[snapshot.state.doc.slides[0],{...snapshot.state.doc.slides[0],id:'second-preview'}]}};
 const publicationSummary={id:publicationId,revision:2,title:'История городов',withdrawn:false};

 const workspaceView={session:workspaceSession,documents:[],binding:null,hasMore:false,nextCursor:'2',messages:[{id:randomUUID(),sequence:'1',role:'user',text:'Покажи **план** как текст',delivery:'cancelled'},{id:randomUUID(),sequence:'2',role:'assistant',text:markdownText,delivery:'published',results:[{available:true,documentId:f.documentId,title:'Учебная презентация',revision:2,currentRevision:2,proposalId,proposalTitle:'Предложение по структуре',proposalStatus:'pending',url:corporatePath+'?proposal='+proposalId}]}]};
 await page.route(url=>url.pathname===corporatePath,async route=>{
   const response=await route.fetch({url:f.origin+'/documents/'+f.documentId}),html=(await response.text()).replace('<body ',`<body data-auth="oidc" data-user-id="${userId}" `);await route.fulfill({response,body:html});
 });
 await page.route(url=>url.pathname.startsWith(apiBase+'/'),async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path===apiBase+'/documents/'+f.documentId+'/copy'){copyCalls.push(route.request().postDataJSON());await route.fulfill({status:copyCalls.length===1?503:403,contentType:'application/json',body:JSON.stringify({error:copyCalls.length===1?'Ответ потерян.':'Копирование недоступно.'})});return;}
   if(path===apiBase+'/library'){
    const pending=new URL(route.request().url()).searchParams.get('pending')==='1';
    await route.fulfill({status:pending&&pendingDenied?403:200,contentType:'application/json',body:JSON.stringify(pending&&pendingDenied?{error:'Доступ к предложениям отозван.'}:{folders:[],documents:pending?[{id:f.documentId,title:'Ожидает проверки',pending:1,revision:2}]:[],nextCursor:null})});return;
   }
   if(path===apiBase+'/publication-catalog'){const query=new URL(route.request().url()).searchParams;await route.fulfill({status:catalogDenied?403:200,contentType:'application/json',body:JSON.stringify(catalogDenied?{error:'Доступ к каталогу отозван.'}:{items:query.get('search')==='нет совпадений'?[]:[{...publicationSummary,id:query.has('cursor')?olderPublicationId:publicationId,revision:query.has('cursor')?1:2,documentId:f.documentId,publishedAt:'2026-09-09T12:00:00.000000Z',publishedBy:'Анна — маркетинг',slideCount:2}],nextCursor:query.has('cursor')||query.get('search')==='нет совпадений'?null:'page-two'})});return;}
   if(path===apiBase+'/documents/'+f.documentId+'/agent-delegations'&&new URL(route.request().url()).searchParams.get('sourcePreview')==='1'){await route.fulfill({contentType:'application/json',body:JSON.stringify({revision:snapshot.state.revision,items:[]})});return;}
   if(path===apiBase+'/documents/'+f.documentId+'/sharing'){await route.fulfill({contentType:'application/json',body:JSON.stringify({authzEpoch:'1',audienceCount:2,audience:[{id:'one',name:'Анна — маркетинг'},{id:'two',name:'Михаил — аналитика'}],entries:[]})});return;}
   if(path.startsWith(publicationBase)){
    if(publicationDenied){await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Доступ отозван.'})});return;}
    if(new URL(route.request().url()).searchParams.get('history')==='1'){await route.fulfill({contentType:'application/json',body:JSON.stringify({items:[],canReadHistory:true,nextCursor:null})});return;}
    if(path.endsWith('/artifacts')){await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#f8f8f5"/><text x="100" y="260" font-family="sans-serif" font-size="96" fill="#20243b">Города и знания</text><text x="100" y="400" font-family="sans-serif" font-size="40" fill="#606879">Поселения связывают ремесло и обмен.</text></svg>'});return;}
    if(route.request().method()==='POST'){
     const body=route.request().postDataJSON();
     if(body.action==='prepare'){await route.fulfill({contentType:'application/json',body:JSON.stringify(publicationPreview)});return;}
     if(body.action==='publish'){publishCalls.push(body);published=true;if(dropPublish){dropPublish=false;await route.abort('failed');return;}}
     if(body.action==='withdraw')published=false;
     await route.fulfill({contentType:'application/json',body:JSON.stringify({...publicationSummary,withdrawn:!published})});return;
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify(path===publicationBase?(catalogMode?{items:[{...publicationSummary,id:new URL(route.request().url()).searchParams.has('cursor')?olderPublicationId:publicationId,revision:new URL(route.request().url()).searchParams.has('cursor')?1:2}],nextCursor:new URL(route.request().url()).searchParams.has('cursor')?null:'page-two'}:{items:published?[publicationSummary]:[]}):{document:{...publicationPreview.document,title:catalogMode?'Сохранённая история':publicationPreview.document.title},origin:{revision:path.endsWith(olderPublicationId)?1:2},permission:{canCopy:true}})});return;
   }

   if(path===apiBase+'/documents/'+f.documentId+'/cover'){await route.fulfill({response:await route.fetch({url:f.origin+'/api/cover?documentId='+f.documentId+'&revision=2'})});return;}
   const data=path===apiBase+'/documents/'+f.documentId?snapshot:path===apiBase+'/conversations'?{sessions:[workspaceSession],nextCursor:null}:path===apiBase+'/conversations/'+workspaceSession.id?workspaceView:(path===apiBase+'/agent-delegations'||path===apiBase+'/documents/'+f.documentId+'/agent-delegations')?{delegations:[],folders:[],sharedFolders:[]}:null;
   if(!data)errors.push('Unexpected corporate fixture request: '+path);
   await route.fulfill({status:data?200:404,contentType:'application/json',body:JSON.stringify(data??{error:'Unexpected fixture request'})});
 });
 await page.goto(f.origin+corporatePath+'?chat');
 const workspace=page.locator('.workspace-chat-inline');
 await workspace.getByRole('heading',{name:'План презентации',exact:true}).waitFor();
 if(process.env.LANKA_UI_REFRESH==='1'){
  await page.setViewportSize({width:390,height:844});
  const toggle=page.getByRole('button',{name:'Совместная работа',exact:true});
  assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  assert.ok((await page.locator('.project-topbar').boundingBox()).height<180);
  assert.equal(await page.getByRole('button',{name:'Доступ',exact:true}).isVisible(),false);
  await page.screenshot({path:join(artifacts,'corporate-header-mobile.png'),fullPage:true});
  await toggle.focus();await toggle.press('Enter');
  for(const name of ['Доступ','Публикации','Подключить агента'])assert.equal(await page.getByRole('button',{name,exact:true}).isVisible(),true);
  await page.getByRole('button',{name:'Подключить агента',exact:true}).click();
  const accessDialog=page.getByRole('dialog');await accessDialog.getByRole('heading',{name:'Агент для этой презентации',exact:true}).waitFor().catch(async error=>{await page.screenshot({path:join(artifacts,'agent-dialog-failure.png'),fullPage:true});console.error(JSON.stringify({pageErrors:errors,dialogs:await accessDialog.allTextContents()}));throw error;});
  const connectionName=accessDialog.getByRole('textbox',{name:'Название подключения агента',exact:true});await connectionName.fill('Агент отдела исследований — проверка длинного названия');
  assert.equal(await connectionName.evaluate(e=>getComputedStyle(e).fontSize),'16px');
  assert.equal(await connectionName.evaluate(e=>getComputedStyle(e).borderRadius),'12px');
  await page.screenshot({path:join(artifacts,'agent-form-mobile.png'),fullPage:true,animations:'disabled'});
  await connectionName.focus();let reachedConnection=false;
  for(let step=0;step<16;step++){
   await page.keyboard.press('Tab');
   const focus=await accessDialog.evaluate(e=>({inside:e.contains(document.activeElement),label:document.activeElement?.textContent}));assert.equal(focus.inside,true);
   if(focus.label==='Адрес сервера и способ подключения'){reachedConnection=true;break;}
  }
  assert.equal(reachedConnection,true,'Keyboard can reach connection details without issuing a key');
  await page.keyboard.press('Enter');
  const serverDetails=accessDialog.locator('details').filter({hasText:'Адрес сервера и способ подключения'});
  assert.equal(await serverDetails.getAttribute('open'),'');
  await page.keyboard.press('PageDown');
  await page.waitForFunction(()=>document.querySelector('.agent-delegation-dialog')?.scrollTop>0);
  assert.equal(await accessDialog.evaluate(e=>e.contains(document.activeElement)),true);
  assert.equal(await accessDialog.evaluate(e=>e.scrollWidth>e.clientWidth+1),false);
  const close=accessDialog.getByRole('button',{name:'Close',exact:true});
  const closeBounds=await close.boundingBox(),dialogBounds=await accessDialog.boundingBox();assert.ok(closeBounds.y>=dialogBounds.y&&closeBounds.y+closeBounds.height<=dialogBounds.y+dialogBounds.height,'Close remains visible after scrolling');
  await page.screenshot({path:join(artifacts,'agent-form-keyboard-bottom.png'),fullPage:true,animations:'disabled'});
  await close.click();await accessDialog.waitFor({state:'hidden'});
  assert.equal(await page.getByRole('button',{name:'Подключить агента',exact:true}).evaluate(e=>e===document.activeElement),true);
  await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'false');
 }

 assert.equal(await workspace.getByRole('table').getByRole('columnheader').count(),6);
 assert.equal(await workspace.getByRole('checkbox').count()>=2,true);
 assert.equal(await workspace.getByText('Покажи **план** как текст',{exact:true}).count(),1);
 assert.equal(await workspace.locator('.workspace-chat-execution').count(),1);
 const resultLink=workspace.getByRole('link',{name:/Предложение по структуре/});assert.equal(await resultLink.getAttribute('href'),corporatePath+'?proposal='+proposalId);
 const taskOptions=workspace.locator('.workspace-chat-options'),taskSummary=taskOptions.locator('summary');
 const action=workspace.getByRole('combobox',{name:'Действие агента',exact:true});assert.equal(await action.isVisible(),false);
 const compactJournalHeight=(await workspace.locator('.workspace-chat-journal').boundingBox()).height;
 await taskSummary.click();assert.equal(await action.isVisible(),true);
 const expandedJournalHeight=(await workspace.locator('.workspace-chat-journal').boundingBox()).height;
 assert.ok(compactJournalHeight-expandedJournalHeight>40,'Collapsed options must provide more room for messages');
 await action.selectOption('propose');await taskSummary.click();assert.match(await taskSummary.innerText(),/Предложить правки/);
 await page.reload();await workspace.getByRole('heading',{name:'План презентации',exact:true}).waitFor();
 assert.equal(await action.isVisible(),false);assert.match(await taskSummary.innerText(),/Предложить правки/);
 await taskSummary.click();assert.equal(await action.inputValue(),'propose');await taskSummary.click();
 const workspaceScroll=workspace.getByRole('region',{name:'Таблица из ответа агента',exact:true});await workspaceScroll.scrollIntoViewIfNeeded();await workspaceScroll.focus();await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>document.querySelector('.workspace-chat-inline .chat-table-scroll').scrollLeft>0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.screenshot({path:join(artifacts,'mobile-workspace-markdown.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await workspaceScroll.scrollIntoViewIfNeeded();
 await page.screenshot({path:join(artifacts,'desktop-workspace-markdown.png'),fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual((await read()).state.doc,current);
 // Publication UI fixture: real clicks and transport retry, synthetic publication responses.
 await page.getByRole('button',{name:'Публикации',exact:true}).click();
 const publicationDialog=page.getByRole('dialog');
 await publicationDialog.getByRole('button',{name:'Подготовить версию 2',exact:true}).click();
 await publicationDialog.getByText('Анна — маркетинг',{exact:true}).waitFor();await publicationDialog.getByText('Михаил — аналитика',{exact:true}).waitFor();
 const publishButton=publicationDialog.getByRole('button',{name:'Опубликовать версию 2',exact:true});await publishButton.waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('.publication-pages img')].length===2&&[...document.querySelectorAll('.publication-pages img')].every(i=>i.complete&&i.naturalWidth>0));
 assert.equal(await publishButton.isEnabled(),true);
 await page.screenshot({path:join(artifacts,'desktop-publication-preview.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await publicationDialog.getByRole('heading',{name:'Кто сможет открыть: 2'}).scrollIntoViewIfNeeded();
 assert.equal(await publicationDialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
 await page.screenshot({path:join(artifacts,'mobile-publication-preview.png'),fullPage:true});
 await publishButton.click();await publicationDialog.getByRole('button',{name:'Повторить ту же операцию'}).click();
 await publicationDialog.getByText('Версия опубликована. Правки исходника не изменят эту публикацию.').waitFor();assert.equal(publishCalls.length,2);assert.deepEqual(publishCalls[0],publishCalls[1]);
 await publicationDialog.getByRole('button',{name:'Версия 2 · История городов',exact:true}).click();await publicationDialog.getByRole('img',{name:'Слайд 1 из 2'}).waitFor();
 assert.equal((await publicationDialog.getByRole('link',{name:'Скачать PDF'}).getAttribute('href')).includes('prepared=true'),false);
 await publicationDialog.getByRole('button',{name:'Создать на основе',exact:true}).click();
 const copyDialog=publicationDialog.getByRole('region',{name:'Копия в вашей библиотеке',exact:true});
 assert.equal(await copyDialog.getByLabel('Название общей копии',{exact:true}).inputValue(),'История городов — копия');
 await copyDialog.getByText(/снимок слайдов версии 2/).waitFor();
 await copyDialog.scrollIntoViewIfNeeded();assert.equal(await publicationDialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);await page.screenshot({path:join(artifacts,'mobile-publication-copy-form.png'),fullPage:true});
 await copyDialog.getByRole('button',{name:'Создать и открыть копию',exact:true}).click();await copyDialog.getByRole('button',{name:'Повторить копирование',exact:true}).waitFor();
 await page.keyboard.press('Escape');assert.equal(await copyDialog.count(),1);
 await copyDialog.getByRole('button',{name:'Повторить копирование',exact:true}).click();await copyDialog.getByRole('alert').filter({hasText:'Копирование недоступно.'}).waitFor();
 assert.equal(copyCalls.length,2);assert.deepEqual(copyCalls[0],copyCalls[1]);assert.equal(copyCalls[0].publicationId,publicationId);assert.equal(copyCalls[0].expectedRevision,2);
 await page.keyboard.press('Escape');
 await page.screenshot({path:join(artifacts,'publication-after-copy-close.png'),fullPage:true});
 assert.equal(await copyDialog.count(),0);assert.equal(await publicationDialog.getByRole('button',{name:'Снять…',exact:true}).count(),1);

 await publicationDialog.getByRole('button',{name:'Снять…',exact:true}).click();await publicationDialog.getByRole('button',{name:'Снять публикацию',exact:true}).click();
 await publicationDialog.getByText('Пока нет опубликованных версий.',{exact:true}).waitFor();
 await publicationDialog.getByRole('button',{name:'Подготовить версию 2',exact:true}).click();await publicationDialog.getByText('Анна — маркетинг',{exact:true}).waitFor();
 publicationDenied=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await publicationDialog.getByRole('alert').filter({hasText:'Доступ отозван.'}).waitFor();assert.equal(await publicationDialog.getByRole('img').count(),0);assert.equal(await publicationDialog.getByText('Анна — маркетинг',{exact:true}).count(),0);

 // Catalogue navigation and pinned version outside the first page.
 publicationDenied=false;published=true;catalogMode=true;
 await page.route(url=>url.pathname==='/organizations/'+tenantId,async route=>{const response=await route.fetch({url:f.origin+'/'});await route.fulfill({response,body:(await response.text()).replace('<body ',`<body data-auth="oidc" data-user-id="${userId}" `)});});
 if(process.env.LANKA_UI_REFRESH==='1') {
  await page.goto(f.origin+'/organizations/'+tenantId+'#home');
  await page.getByRole('heading',{name:'Главная',exact:true}).waitFor();
  await page.getByRole('button',{name:'Шаблоны',exact:true}).click();
  await page.reload({waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'Шаблоны',exact:true}).waitFor();
  await page.locator('.creation-design-heading input[value="focus-v3"]').check();
  await page.getByRole('button',{name:'Создать презентацию',exact:true}).click();
  assert.equal(await page.locator('.library-create select').inputValue(),'focus-v3');
  await page.locator('.library-create').getByRole('button',{name:'Отмена',exact:true}).click();
  await page.getByRole('button',{name:'Обсудить со своим агентом',exact:true}).click();
  const homeChat=page.locator('.workspace-chat-dialog');await homeChat.waitFor();
  await homeChat.getByRole('textbox',{name:'Сообщение',exact:true}).fill('Черновик с корпоративной главной');
  await page.keyboard.press('Escape');await homeChat.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Обсудить со своим агентом',exact:true}).click();
  assert.equal(await homeChat.getByRole('textbox',{name:'Сообщение',exact:true}).inputValue(),'Черновик с корпоративной главной');
  await page.keyboard.press('Escape');
  await page.screenshot({path:join(artifacts,'corporate-home.png'),fullPage:true});
  const pendingRegion=page.getByRole('region',{name:'Предложения в моих документах',exact:true});
  await pendingRegion.getByRole('link',{name:/Ожидает проверки/}).waitFor();
  pendingDenied=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await pendingRegion.getByRole('alert').waitFor();assert.equal(await pendingRegion.getByRole('link').count(),0);pendingDenied=false;

 }
 await page.goto(f.origin+'/organizations/'+tenantId+'#publications');
 const catalog=page.getByRole('main');await catalog.getByRole('heading',{name:'Публикации',exact:true}).waitFor();
 await catalog.getByRole('link',{name:/История городов/}).waitFor();
 await page.setViewportSize({width:1440,height:1000});
 await catalog.locator('.publication-cover img').first().evaluate(img=>img.decode());
 if(process.env.LANKA_UI_REFRESH==='1')assert.ok(await catalog.locator('.publication-cover').first().evaluate(e=>{const r=e.getBoundingClientRect();return Math.abs(r.width/r.height-16/9)<.01;}),'Publication cover must remain 16:9');
 await page.screenshot({path:join(artifacts,'desktop-publication-library.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(artifacts,'mobile-publication-library.png'),fullPage:true});
 await catalog.getByRole('button',{name:'Список',exact:true}).click();
 await catalog.locator('.shared-library-compact').waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:join(artifacts,'mobile-publication-list.png'),fullPage:true});
 await catalog.getByRole('button',{name:'Карточки',exact:true}).click();
 await catalog.getByRole('textbox',{name:'Поиск публикаций'}).fill('нет совпадений');await catalog.getByRole('heading',{name:'Ничего не найдено'}).waitFor();
 await catalog.getByRole('textbox',{name:'Поиск публикаций'}).fill('');await catalog.getByRole('button',{name:'Следующая',exact:true}).click();await catalog.getByText('Страница 2',{exact:true}).waitFor();
 const oldLink=catalog.getByRole('link',{name:/История городов/});assert.ok((await oldLink.getAttribute('href')).endsWith('?publication='+olderPublicationId));await oldLink.click();
 const pinned=page.getByRole('dialog');await pinned.getByRole('heading',{name:'Версия 1 · Сохранённая история',exact:true}).waitFor();await pinned.getByRole('img',{name:'Слайд 1 из 2'}).waitFor();
 assert.ok((await pinned.getByRole('link',{name:'Скачать PDF'}).getAttribute('href')).includes(olderPublicationId));
 await pinned.getByRole('navigation',{name:'Страницы публикаций'}).getByRole('button',{name:'Следующая'}).click();await pinned.getByText('Страница 2',{exact:true}).waitFor();
 await pinned.getByRole('heading',{name:'Версия 1 · Сохранённая история',exact:true}).waitFor();
 await page.reload();await pinned.getByRole('heading',{name:'Версия 1 · Сохранённая история',exact:true}).waitFor();
 await page.screenshot({path:join(artifacts,'mobile-publication-pinned.png'),fullPage:true});
 publicationDenied=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await pinned.getByRole('alert').filter({hasText:'Доступ отозван.'}).waitFor();assert.equal(await pinned.getByRole('img').count(),0);
 await page.goto(f.origin+'/organizations/'+tenantId+'#publications');await catalog.getByRole('link',{name:/История городов/}).waitFor();catalogDenied=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await catalog.getByRole('alert').waitFor();assert.equal(await catalog.getByRole('link',{name:/История городов/}).count(),0);
 assert.deepEqual(errors,[]);assert.deepEqual((await read()).state.doc,current);
 // Review presentation fixture: browsing does not submit acceptance commands.
 const reviewAfter=structuredClone(current.slides[0]);reviewAfter.canvas.find(e=>e.id==='layer-title').text='Знания становятся общими';
 const reviewProposal={id:randomUUID(),title:'Уточнить главный вывод',author:'local-agent',baseRevision:2,createdAt:new Date().toISOString(),status:'pending',changes:[{id:randomUUID(),slideId:reviewAfter.id,before:current.slides[0],after:reviewAfter,status:'pending'}]};
 await page.route(url=>url.pathname==='/api/project',async route=>{assert.equal(route.request().method(),'GET');const response=await route.fetch();const data=await response.json();await route.fulfill({response,json:{...data,state:{...data.state,proposals:[reviewProposal]}}});});
 await page.setViewportSize({width:390,height:844});
 await page.goto(f.origin+'/documents/'+f.documentId+'?review=1');
 const compare=page.getByRole('group',{name:'Режим сравнения'});await compare.waitFor();
 if(process.env.LANKA_UI_REFRESH==='1')assert.equal(await compare.getByRole('button',{name:'После',exact:true}).getAttribute('aria-pressed'),'true');
 await compare.getByRole('button',{name:'До',exact:true}).click();assert.equal(await page.locator('.review-pair>div').count(),1);
 await compare.getByRole('button',{name:'После',exact:true}).click();assert.equal(await page.locator('.review-pair>div').count(),1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:join(artifacts,'mobile-review.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await compare.getByRole('button',{name:'Рядом',exact:true}).click();assert.equal(await page.locator('.review-pair>div').count(),2);
 await page.screenshot({path:join(artifacts,'desktop-review.png'),fullPage:true});
 assert.deepEqual((await read()).state.doc,current);assert.deepEqual(errors,[]);
 result={reviewBrowsingDocumentUnchanged:true,reviewComparisonModes:true,syntheticReviewResponse:true,checkedAt:new Date().toISOString(),headless:true,syntheticChatResponses:true,syntheticPublicationResponses:true,publicationCatalogNavigation:true,publicationCatalogPagination:true,publicationCatalogRevocation:true,publicationPinnedLinkAndReload:true,publicationOlderVersionOutsideFirstPage:true,publicationAudienceVisible:true,publicationPreviewPages:2,publicationMobileNoOverflow:true,publicationRetryExact:true,publicationWithdrawal:true,publicationCopyForm:true,publicationCopyRetryExact:true,publicationRevocationClearsPreview:true,realAgentStarted:false,terminalEmptyMessagesDoNotShowWaiting:true,streamingToFailureUpdates:true,proposalLinkPreserved:true,gfmTableRendered:true,wideTableKeyboardScrollable:true,taskListRendered:true,codeBlockRendered:true,workspaceMarkdownRendered:true,workspaceTableKeyboardScrollable:true,workspaceResultLinkPreserved:true,workspaceExecutionStatusPreserved:true,taskOptionsCollapseAndReload:true,taskOptionsSpaceSaved:compactJournalHeight-expandedJournalHeight,documentUnchanged:true,mobileWidth:390,horizontalOverflow:overflow,pageErrors:errors};

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
assert.ok(result,'Chat browser scenario did not finish');
await writeFile(join(artifacts,'result.json'),JSON.stringify({...result,isolatedWorkspaceRemoved:true,testServerStopped:true},null,2)+'\n');
console.log('Chat browser checks passed. Evidence: '+artifacts);
