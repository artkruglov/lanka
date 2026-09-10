import {randomUUID,createHash} from 'node:crypto';
import {createServer,request} from 'node:http';
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';

/** Test-only loopback proxy supplies the disposable IdP user's session to the real
 * Compose backend. No synthetic API bodies; this does not prove a real IdP login. */
export async function checkPublicationBrowser({port,cookie,tenant,documentId,publicationId,revision,artifacts,hideCopyImage}){
 const proxy=createServer((req,res)=>{
  const upstream=request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,host:'lanka.example.invalid',cookie,...(req.headers.origin?{origin:'https://lanka.example.invalid'}:{})}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
 });
 let browser;
 try{
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const origin='http://127.0.0.1:'+proxy.address().port,base='/organizations/'+tenant,path='/api'+base+'/documents/'+documentId;
  const before=await(await page.request.get(origin+path)).json();
  const folderId=randomUUID(),emptyFolderId=randomUUID();
  const libraryWrite=async(command,requestId=randomUUID())=>{const response=await page.request.post(origin+'/api'+base+'/library',{headers:{Origin:origin},data:{requestId,command}});assert.equal(response.status(),200);};
  await libraryWrite({action:'create_folder',name:'Материалы отдела'},folderId);await libraryWrite({action:'create_folder',name:'Пустая папка'},emptyFolderId);
  await libraryWrite({action:'move_document',id:documentId,folderId});
  if(process.env.LANKA_UI_REFRESH==='1'){
   await page.goto(origin+base+'#home');await page.getByRole('heading',{name:'Главная',exact:true}).waitFor();
   await page.getByRole('button',{name:'Обсудить со своим агентом',exact:true}).click();
   await page.locator('.workspace-chat-dialog').waitFor();await page.keyboard.press('Escape');await page.locator('.workspace-chat-dialog').waitFor({state:'hidden'});
   await page.getByRole('button',{name:'Шаблоны',exact:true}).click();
   await page.reload();await page.getByRole('heading',{name:'Шаблоны',exact:true}).waitFor();
   assert.equal(await page.locator('.creation-design-preview svg').count(),2);
   await page.locator('.creation-design-heading input[value="focus-v3"]').check();
   await page.getByRole('button',{name:'Создать презентацию',exact:true}).click();
   assert.equal(await page.locator('.library-create select').inputValue(),'focus-v3');
   await page.getByRole('textbox',{name:'Название презентации',exact:true}).fill('Корпоративный шаблон: проверка');
   await page.locator('.library-create').getByRole('button',{name:'Создать',exact:true}).click();
   await page.waitForURL(url=>url.pathname.startsWith(base+'/documents/'));
   const templateDocumentId=new URL(page.url()).pathname.split('/').pop();
   const createdResponse=await page.request.get(origin+'/api'+base+'/documents/'+templateDocumentId);assert.equal(createdResponse.status(),200);
   const templateDocument=await createdResponse.json();assert.equal(templateDocument.state.doc.design,'focus-v3');assert.equal(templateDocument.state.doc.title,'Корпоративный шаблон: проверка');
   await page.reload();await page.locator('.project-stage .slide-canvas').waitFor();assert.equal(await page.getByRole('button',{name:'Показать',exact:true}).isEnabled(),true);await page.evaluate(()=>document.fonts.ready);
   await mkdir(artifacts,{recursive:true});await page.screenshot({path:join(artifacts,'template-created.png'),fullPage:false});
   const mobileBefore=(await (await page.request.get(origin+'/api'+base+'/documents/'+templateDocumentId)).json()).state;
   await page.setViewportSize({width:390,height:844});
   const collaboration=page.getByRole('button',{name:'Совместная работа',exact:true});
   assert.equal(await collaboration.getAttribute('aria-expanded'),'false');
   assert.ok((await page.locator('.project-topbar').boundingBox()).height<180);
   await page.screenshot({path:join(artifacts,'corporate-header-mobile.png'),fullPage:true});
   await collaboration.focus();await collaboration.press('Enter');
   for(const [button,title] of [['Доступ','Доступ к презентации'],['Публикации','Опубликованные версии'],['Подключить агента','Агент для этой презентации']]){
    const trigger=page.getByRole('button',{name:button,exact:true});await trigger.click();
    const panel=page.getByRole('dialog');await panel.getByRole('heading',{name:title,exact:true}).waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await panel.getByRole('alert').count(),0);
    assert.ok(await panel.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth+1;}));
    await page.screenshot({path:join(artifacts,'corporate-'+(button==='Доступ'?'sharing':button==='Публикации'?'publications':'agent')+'-mobile.png'),fullPage:true,animations:'disabled'});
    await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
    assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
   }
   await collaboration.click();
   assert.deepEqual((await (await page.request.get(origin+'/api'+base+'/documents/'+templateDocumentId)).json()).state,mobileBefore);
   await page.setViewportSize({width:1440,height:1000});
   await page.locator('.canvas-layer-list summary').click();
   const picker=page.getByLabel('Выбрать объект',{exact:true});
   const objectId=await picker.locator('option').evaluateAll(options=>options.find(o=>o.value)?.value);assert.ok(objectId);
   await picker.selectOption(objectId);
   await page.locator('.object-inspector .canvas-properties').waitFor();
   assert.equal(await page.locator('.object-inspector .canvas-properties').count(),1);
   await page.screenshot({path:join(artifacts,'corporate-object-inspector.png'),fullPage:false});
   await page.setViewportSize({width:390,height:844});
   await page.getByRole('navigation',{name:'Панели редактора',exact:true}).getByRole('button',{name:'Содержание',exact:true}).click();
   await page.locator('.object-inspector .canvas-properties').waitFor();
   await page.screenshot({path:join(artifacts,'corporate-object-inspector-mobile.png'),fullPage:true});
   assert.deepEqual((await (await page.request.get(origin+'/api'+base+'/documents/'+templateDocumentId)).json()).state,mobileBefore);
   await page.setViewportSize({width:1440,height:1000});
   await libraryWrite({action:'trash_document',id:templateDocumentId,trashed:true});

  }
  await page.goto(origin+base+'#publications');
  assert.equal(await page.locator('body').getAttribute('data-ui'),process.env.LANKA_UI_REFRESH==='1'?'refresh':'classic');
  await page.getByRole('navigation',{name:'Папки публикаций'}).getByRole('button',{name:'Пустая папка',exact:true}).click();
  await page.getByRole('heading',{name:'Пустая папка',exact:true}).waitFor();await page.getByRole('heading',{name:'Здесь появятся опубликованные версии',exact:true}).waitFor();
  await page.getByRole('navigation',{name:'Путь папки публикаций'}).getByRole('button',{name:'Все публикации'}).click();
  await page.getByRole('navigation',{name:'Папки публикаций'}).getByRole('button',{name:'Материалы отдела',exact:true}).click();
  await page.getByRole('heading',{name:'Материалы отдела',exact:true}).waitFor();assert.match(new URL(page.url()).hash,/^#publications\/[a-f0-9-]{36}$/);
  await page.reload();await page.getByRole('heading',{name:'Материалы отдела',exact:true}).waitFor();
  const link=page.locator(`a[href="${base}/documents/${documentId}?publication=${publicationId}"]`);await link.waitFor();
  const card=page.locator('li').filter({has:link});await card.getByRole('button',{name:'Нравится',exact:true}).click();await card.getByRole('button',{name:'Убрать лайк',exact:true}).waitFor();
  await card.getByRole('button',{name:'В избранное',exact:true}).click();await card.getByRole('button',{name:'Убрать из избранного',exact:true}).waitFor();
  await page.reload();await card.getByRole('button',{name:'Убрать лайк',exact:true}).waitFor();await card.getByRole('button',{name:'Убрать из избранного',exact:true}).waitFor();
  await page.getByRole('button',{name:'Избранные документы',exact:true}).click();await link.waitFor();
  await card.getByRole('button',{name:'Убрать из избранного',exact:true}).click();await page.getByRole('heading',{name:'В избранном пока нет опубликованных документов',exact:true}).waitFor();
  await page.getByRole('button',{name:'Избранные документы',exact:true}).click();await link.waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.publication-cover img')].some(i=>i.complete&&i.naturalWidth>0));
  await mkdir(artifacts,{recursive:true});await page.screenshot({path:join(artifacts,'desktop.png'),fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(artifacts,'mobile.png'),fullPage:true,animations:'disabled'});
  await link.click();const dialog=page.getByRole('dialog');
  await dialog.getByRole('heading',{name:new RegExp('^Версия '+revision+' · ')}).waitFor();
  await page.waitForFunction(()=>{const images=[...document.querySelectorAll('.publication-pages img')];return images.length===2&&images.every(i=>i.complete&&i.naturalWidth>0);});
  const pdf=await dialog.getByRole('link',{name:'Скачать PDF'}).getAttribute('href');assert.ok(pdf.includes(publicationId)&&!pdf.includes('prepared=true'));
  assert.equal((await page.request.get(origin+pdf)).status(),200);
  const dependenciesUrl=await dialog.getByRole('link',{name:'Шрифты и сведения о версии'}).getAttribute('href');assert.equal((await page.request.get(origin+dependenciesUrl)).status(),200);
  await page.reload();await dialog.getByRole('heading',{name:new RegExp('^Версия '+revision+' · ')}).waitFor();
  await dialog.evaluate(el=>Promise.all(el.getAnimations({subtree:true}).filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
  const surface=await dialog.evaluate(el=>({opacity:getComputedStyle(el).opacity,background:getComputedStyle(el).backgroundColor}));assert.equal(surface.opacity,'1');assert.notEqual(surface.background,'rgba(0, 0, 0, 0)');
  await page.screenshot({path:join(artifacts,'pinned.png'),fullPage:true,animations:'disabled'});
  await dialog.getByRole('button',{name:'Создать на основе',exact:true}).click();
  await dialog.getByLabel('Название общей копии',{exact:true}).fill('Копия из каталога — браузер');
  await dialog.getByRole('button',{name:'Создать и открыть копию',exact:true}).click();
  await page.waitForURL(url=>url.pathname.startsWith(base+'/documents/')&&!url.pathname.endsWith(documentId));
  const copyId=new URL(page.url()).pathname.split('/').at(-1),copy=await(await page.request.get(origin+'/api'+base+'/documents/'+copyId)).json();
  assert.equal(copy.state.revision,1);assert.equal(copy.state.doc.title,'Копия из каталога — браузер');assert.equal(copy.state.doc.slides.length,2);
  const copyPath='/api'+base+'/documents/'+copyId,changed=structuredClone(copy.state.doc);changed.title='Изменённый черновик';
  assert.equal((await page.request.post(origin+copyPath,{headers:{Origin:origin},data:{requestId:randomUUID(),deckId:copyId,expectedRevision:1,command:{action:'save',doc:changed,editorContract:'lanka-editor/3'}}})).status(),200);
  const historicalImage=copy.state.sources.find(s=>s.kind==='image');assert.ok(historicalImage);
  await hideCopyImage(copyId,historicalImage.sha256);
  await page.setViewportSize({width:1440,height:1000});await page.reload();await page.getByRole('tab',{name:'История',exact:true}).click();
  await page.locator('.history-versions button').filter({hasText:'Версия 1'}).click();
  await page.getByRole('heading',{name:'Версия 1: '+copy.state.doc.title,exact:true}).waitFor();
  const archivedImage=page.locator('.history-slide .review-pair > div:first-child svg image').first();await archivedImage.waitFor();
  const archivedUrl=await archivedImage.getAttribute('href');assert.ok(archivedUrl.includes('revision=1'));
  const archivedResponse=await page.request.get(origin+archivedUrl);assert.equal(archivedResponse.status(),200);
  assert.equal(createHash('sha256').update(await archivedResponse.body()).digest('hex'),historicalImage.sha256);
  await page.screenshot({path:join(artifacts,'history-archive.png'),fullPage:true,animations:'disabled'});
  const restoredRequest=page.waitForResponse(r=>r.url()===origin+copyPath&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Восстановить эту версию',exact:true}).click();assert.equal((await restoredRequest).status(),200);
  const restored=await(await page.request.get(origin+copyPath)).json();assert.equal(restored.state.revision,3);assert.deepEqual(restored.state.doc,copy.state.doc);assert.deepEqual(restored.state.sources,copy.state.sources);
  const currentImage=await page.request.get(origin+copyPath+'/assets?id='+historicalImage.id);assert.equal(currentImage.status(),200);assert.equal(createHash('sha256').update(await currentImage.body()).digest('hex'),historicalImage.sha256);
  await page.reload();await page.getByRole('tab',{name:'История',exact:true}).click();await page.locator('.history-versions button').filter({hasText:'Версия 3'}).waitFor();
  await libraryWrite({action:'move_document',id:documentId,folderId:null});
  const after=await(await page.request.get(origin+path)).json();assert.deepEqual(after.state.doc,before.state.doc);assert.equal(after.state.revision,before.state.revision);
  assert.deepEqual(errors,[]);
  return {realBackend:true,corporateObjectInspector:process.env.LANKA_UI_REFRESH==='1',corporateMobileDialogs:process.env.LANKA_UI_REFRESH==='1',templateCreatedFromCatalog:process.env.LANKA_UI_REFRESH==='1',syntheticApiResponses:false,testSessionProxy:true,realIdpLogin:false,desktop:true,mobile:true,folderNavigation:true,reactionsPersisted:true,bookmarkFilter:true,emptyFolder:true,folderReload:true,pinnedRevision:revision,reloadPinned:true,pdfDownloaded:true,copyFromBrowser:true,archivedHistoryImage:true,restoreFromBrowser:true,restoredImageExact:true,sourceUnchanged:true,pageErrors:errors};
 }finally{await browser?.close();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
}

export async function checkPublicationRoles({port,ownerCookie,readerCookie,tenant,documentId,revision,artifacts,hideCurrentImage,restoreCurrentImage}){
 const proxies=[];let browser;
 const proxyFor=async cookie=>{
  const server=createServer((req,res)=>{const upstream=request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,host:'lanka.example.invalid',cookie,...(req.headers.origin?{origin:'https://lanka.example.invalid'}:{})}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);});
  proxies.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;
 };
 try{
  const ownerOrigin=await proxyFor(ownerCookie),readerOrigin=await proxyFor(readerCookie),base='/organizations/'+tenant+'/documents/'+documentId;
  browser=await chromium.launch({headless:true});const owner=await browser.newPage(),reader=await browser.newPage({viewport:{width:390,height:844}}),errors=[];for(const p of [owner,reader])p.on('pageerror',e=>errors.push(e.message));
  await owner.goto(ownerOrigin+base);await owner.getByRole('button',{name:'Публикации',exact:true}).click();const manager=owner.getByRole('dialog');
  await manager.getByRole('button',{name:'Подготовить версию '+revision,exact:true}).click();const publish=manager.getByRole('button',{name:'Опубликовать версию '+revision,exact:true});
  await publish.waitFor();await owner.waitForFunction(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Опубликовать версию'));return button&&!button.disabled;});
  await publish.click();await manager.getByText('Версия опубликована. Правки исходника не изменят эту публикацию.').waitFor();
  const listing=await(await owner.request.get(ownerOrigin+'/api'+base+'/publications')).json(),publication=listing.items.find(p=>p.revision===revision);assert.ok(publication);
  await reader.goto(readerOrigin+base+'?publication='+publication.id);const viewer=reader.getByRole('dialog');
  await viewer.getByRole('heading',{name:new RegExp('^Версия '+revision+' · ')}).waitFor();
  assert.equal(await viewer.getByRole('button',{name:/Подготовить версию|Снять…/}).count(),0);
  const download=await viewer.getByRole('link',{name:'Скачать PDF'}).getAttribute('href');assert.equal((await reader.request.get(readerOrigin+download)).status(),200);
  const forbidden=await reader.request.post(readerOrigin+'/api'+base+'/publications',{headers:{Origin:readerOrigin},data:{action:'prepare',expectedRevision:revision}});assert.equal(forbidden.status(),403);
  await mkdir(artifacts,{recursive:true});await reader.screenshot({path:join(artifacts,'reader.png'),fullPage:true,animations:'disabled'});
  const row=manager.locator('li').filter({has:owner.getByRole('button',{name:'Версия '+revision+' · '+publication.title,exact:true})});
  await row.getByRole('button',{name:'Снять…',exact:true}).click();await manager.getByRole('button',{name:'Снять публикацию',exact:true}).click();await manager.getByText('Публикация снята. Новые просмотры и скачивания закрыты.').waitFor();
  await reader.evaluate(()=>window.dispatchEvent(new Event('focus')));await viewer.getByRole('alert').waitFor();assert.equal(await viewer.locator('.publication-pages img').count(),0);assert.equal((await reader.request.get(readerOrigin+download)).status(),404);
  await manager.getByRole('button',{name:'Показать снятые',exact:true}).click();
  const withdrawnLabel='Версия '+revision+' · '+publication.title+' · Снята. Просмотр и скачивание закрыты.';
  await manager.getByText(withdrawnLabel,{exact:true}).waitFor();
  const withdrawnRow=manager.locator('li').filter({hasText:withdrawnLabel});assert.equal(await withdrawnRow.locator('button,a').count(),0);
  assert.equal((await owner.request.get(ownerOrigin+download)).status(),404);
  assert.equal((await reader.request.get(readerOrigin+'/api'+base+'/publications?includeWithdrawn=true')).status(),403);
  assert.equal(await viewer.getByRole('button',{name:'Показать снятые',exact:true}).count(),0);
  await manager.getByRole('button',{name:'Показать снятые',exact:true}).click();await manager.getByText(withdrawnLabel,{exact:true}).waitFor({state:'hidden'});
  await hideCurrentImage();
  try{
   await manager.getByRole('combobox',{name:'Версия для публикации'}).selectOption('2');
   await manager.getByRole('button',{name:'Подготовить версию 2',exact:true}).click();
   const historicalPublish=manager.getByRole('button',{name:'Опубликовать версию 2',exact:true});await historicalPublish.waitFor();
   await owner.waitForFunction(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Опубликовать версию 2');return button&&!button.disabled;});
   await owner.screenshot({path:join(artifacts,'historical-preview.png'),fullPage:true,animations:'disabled'});
   await historicalPublish.click();await manager.getByText('Версия опубликована. Правки исходника не изменят эту публикацию.').waitFor();
   const oldListing=await(await owner.request.get(ownerOrigin+'/api'+base+'/publications')).json(),oldPublication=oldListing.items.find(p=>p.revision===2);assert.ok(oldPublication);
   await reader.goto(readerOrigin+base+'?publication='+oldPublication.id);await viewer.getByRole('heading',{name:/^Версия 2 · /}).waitFor();
   const oldPdf=await viewer.getByRole('link',{name:'Скачать PDF'}).getAttribute('href');assert.equal((await reader.request.get(readerOrigin+oldPdf)).status(),200);
   const oldRow=manager.locator('li').filter({has:owner.getByRole('button',{name:'Версия 2 · '+oldPublication.title,exact:true})});await oldRow.getByRole('button',{name:'Снять…',exact:true}).click();await manager.getByRole('button',{name:'Снять публикацию',exact:true}).click();await manager.getByText('Публикация снята. Новые просмотры и скачивания закрыты.').waitFor();
  }finally{await restoreCurrentImage();}
  assert.deepEqual(errors,[]);return {realBackend:true,twoIdentities:true,historicalPublication:true,historicalImageWithoutCurrentBlob:true,ownerPreparedAndPublished:true,readerOpened:true,readerCannotPrepare:true,readerNoManagerControls:true,ownerWithdrew:true,ownerWithdrawalAudit:true,withdrawnFilesRemainDenied:true,readerPreviewCleared:true,downloadAfterWithdrawalDenied:true,pageErrors:errors};
 }finally{await browser?.close();for(const proxy of proxies){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}}
}

/** Real packaged proposal -> personal Home -> browser acceptance; disposable session proxy. */
export async function checkPendingReviewBrowser({port,cookie,tenant,documentId,artifacts}){
 const proxy=createServer((req,res)=>{const upstream=request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,host:'lanka.example.invalid',cookie,...(req.headers.origin?{origin:'https://lanka.example.invalid'}:{})}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);});
 let browser;
 try{
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const origin='http://127.0.0.1:'+proxy.address().port,base='/organizations/'+tenant;
  await page.goto(origin+base+'#home',{waitUntil:'networkidle'});assert.equal(await page.locator('body').getAttribute('data-ui'),'refresh');
  const pending=page.getByRole('region',{name:'Предложения в моих документах',exact:true});
  const link=pending.locator(`a[href="${base}/documents/${documentId}?review=1"]`);await link.waitFor();
  await mkdir(artifacts,{recursive:true});await page.screenshot({path:join(artifacts,'pending-home.png'),fullPage:true});
  await link.click();await page.getByRole('button',{name:/Принять оставшиеся правки/}).click();
  await page.getByRole('heading',{name:'Нет изменений, ожидающих решения',exact:true}).waitFor();
  await page.goto(origin+base+'#home',{waitUntil:'networkidle'});assert.equal(await pending.count(),0);
  assert.deepEqual(errors,[]);return {realBackend:true,packagedMcpProposal:true,homeShowsPending:true,browserAccepted:true,homeClearedAfterAcceptance:true,pageErrors:errors};
 }finally{await browser?.close();await new Promise(resolve=>{proxy.closeAllConnections();proxy.close(resolve);});}
}
