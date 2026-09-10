import {ProjectClient} from './project-mcp/client.mjs';
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=await realpath(await mkdtemp(join(tmpdir(),'lanka-ui-refresh-')));
await mkdir('out',{recursive:true});
const output=await mkdtemp(resolve('out/ui-refresh-check-'));
const children=[];let browser;
async function start(refresh){
 const child=spawn(process.execPath,[resolve('.project-runtime/web.mjs'),'--workspace',root,'--port','0'],{env:{...process.env,LANKA_UI_REFRESH:refresh?'1':'0'},stdio:['ignore','pipe','pipe']});
 children.push(child);
 return new Promise((res,rej)=>{let data='';const timeout=setTimeout(()=>rej(Error('Startup timeout')),20000);child.once('error',e=>{clearTimeout(timeout);rej(e);});child.once('exit',()=>{clearTimeout(timeout);rej(Error('Server exited'));});child.stdout.on('data',d=>{data+=d;const m=data.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timeout);res(m[0]);}});});
}
try{
 const classic=await start(false);
 const cookie=(await fetch(classic)).headers.get('set-cookie').split(';')[0];
 const r=await fetch(classic+'/api/library',{method:'POST',headers:{Cookie:cookie,Origin:classic,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),command:{action:'create_document',title:'Проверка стиля · учебный документ',folderId:null,profile:'focus-v3'}})});
 assert.equal(r.status,200);const doc=await r.json();
 const refresh=await start(true);browser=await chromium.launch({headless:true});
 const records=[];const images=[];const errors=[];
 for(const [name,origin] of [['classic',classic],['refresh',refresh]]){
  const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/documents/'+doc.id,{waitUntil:'networkidle'});
  await page.locator('.project-stage .slide-canvas').first().waitFor();await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.locator('body').getAttribute('data-ui'),name);
  const canvas=page.locator('.project-stage .slide-canvas').first();
  // Neutralize UI backing/shadow during the isolated SVG comparison. Fractional SVG edges
  // otherwise include a row of surrounding chrome. Dimensions and SVG content stay unchanged.
  const backing=await canvas.evaluate(e=>{const parent=e.parentElement,editor=e.closest('.canvas-editor'),old={background:parent.style.background,shadow:parent.style.boxShadow,editor:editor.style.background};parent.style.background='#fff';parent.style.boxShadow='none';editor.style.background='#fff';return old;});
  const slide=await canvas.screenshot({path:join(output,name+'-slide.png')});images.push(slide);
  await canvas.evaluate((e,old)=>{e.parentElement.style.background=old.background;e.parentElement.style.boxShadow=old.shadow;e.closest('.canvas-editor').style.background=old.editor;},backing);
  await page.screenshot({path:join(output,name+'-desktop.png'),fullPage:true});
  const stageColor=await page.locator('.project-stage').evaluate(e=>getComputedStyle(e).backgroundColor);
  const button=page.locator('[data-slot="button"][data-variant="default"]').first();
  const buttonColor=await button.evaluate(e=>getComputedStyle(e).backgroundColor);
  records.push({name,stageColor,buttonColor,slideHash:createHash('sha256').update(slide).digest('hex')});
  if(name==='refresh') {
   const divider=page.getByRole('separator',{name:'Ширина правой панели'});
   const originalSvg=await canvas.innerHTML();
   const filmstripWidth=await page.locator('.project-slides').evaluate(e=>e.getBoundingClientRect().width);
   await divider.focus();await divider.press('End');
   assert.equal(await page.locator('.project-inspector').evaluate(e=>Math.round(e.getBoundingClientRect().width)),560);
   assert.equal(await canvas.innerHTML(),originalSvg);
   assert.equal(await page.locator('.project-slides').evaluate(e=>e.getBoundingClientRect().width),filmstripWidth);
   await page.reload({waitUntil:'networkidle'});await divider.waitFor();
   assert.equal(await page.locator('.project-inspector').evaluate(e=>Math.round(e.getBoundingClientRect().width)),560);
   await page.screenshot({path:join(output,'inspector-expanded.png'),fullPage:true});
   const dividerBox=await divider.boundingBox();await page.mouse.move(dividerBox.x+4,dividerBox.y+100);await page.mouse.down();await page.mouse.move(dividerBox.x+104,dividerBox.y+100);await page.mouse.up();
   assert.equal(await page.locator('.project-inspector').evaluate(e=>Math.round(e.getBoundingClientRect().width)),460);
   await divider.focus();await divider.press('End');
   await page.setViewportSize({width:950,height:800});
   assert.ok(await page.locator('.project-inspector').evaluate(e=>e.getBoundingClientRect().width<=510));
   await page.setViewportSize({width:1600,height:1000});
   await page.waitForFunction(()=>Math.round(document.querySelector('.project-inspector').getBoundingClientRect().width)===560);
   await page.setViewportSize({width:390,height:844});assert.equal(await divider.count(),0);
   await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.includes('lanka:inspector-width:v1'))localStorage.removeItem(key);});
   await page.setViewportSize({width:1600,height:1000});await page.reload({waitUntil:'networkidle'});
   const layers=page.locator('.canvas-layer-list'),summary=layers.locator('summary'),picker=page.getByLabel('Выбрать объект',{exact:true});
   assert.equal(await picker.isVisible(),false);
   await summary.focus();await summary.press('Enter');await picker.waitFor({state:'visible'});
   const objectId=await picker.locator('option').nth(1).getAttribute('value');assert.ok(objectId);
   await picker.selectOption(objectId);
   assert.equal(await layers.getAttribute('open'),null);
   assert.equal(await page.locator('.canvas-interaction').evaluate(e=>e===document.activeElement),true);
   assert.equal(await page.locator('.object-inspector .canvas-properties').count(),1);
   assert.equal(await page.locator('.project-stage .canvas-properties').count(),0);
   assert.equal(await page.locator('.project-brief').isVisible(),false);
   const arrange=page.getByRole('button',{name:'Расположение и действия объекта',exact:true});
   const surface=page.locator('.canvas-edit-surface');
   const beforeMenu=await surface.boundingBox();await arrange.focus();await arrange.press('Enter');
   const menu=page.getByRole('dialog',{name:'Расположение и действия объекта',exact:true});await menu.waitFor();
   assert.deepEqual(await surface.boundingBox(),beforeMenu,'Arrangement menu must not move the canvas');
   await page.screenshot({path:join(output,'arrangement-desktop.png'),fullPage:true,animations:'disabled'});
   await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Расположение и действия объекта');assert.equal(await arrange.evaluate(e=>e===document.activeElement),true);
   await page.setViewportSize({width:390,height:844});
   await arrange.click();await menu.waitFor();
   assert.ok(await menu.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
   await page.screenshot({path:join(output,'arrangement-mobile.png'),fullPage:true,animations:'disabled'});
   await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
   await page.screenshot({path:join(output,'selected-object-mobile.png'),fullPage:true});
   await page.setViewportSize({width:1600,height:1000});
   records.push({surface:'arrangement',keyboardMenu:true,canvasDoesNotMove:true,escapeRestoresFocus:true,mobileMenuFits:true});
   await page.locator('.object-inspector').getByRole('button',{name:'Свойства слайда',exact:true}).click();
   assert.equal(await page.locator('.project-brief').isVisible(),true);
   assert.equal(await page.locator('.object-inspector .canvas-properties').count(),0);
   records.push({surface:'context-inspector',propertiesInSidebar:true,slideFieldsHiddenOnSelection:true,returnToSlideProperties:true});
   records.push({surface:'object-selection',keyboardLayers:true,closesAfterSelection:true,canvasReceivesFocus:true});
  }
  if(name==='refresh')for(const width of [768,1280]) {
   await page.setViewportSize({width,height:1000});
   assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth),`Editor overflow at ${width}`);
   if(width===768)assert.ok(await page.locator('.canvas-toolbar button,.canvas-toolbar select').evaluateAll(items=>items.filter(e=>e.getClientRects().length).every(e=>e.getBoundingClientRect().height>=44)));
   const bounds=await page.locator('.project-stage .slide-canvas').first().boundingBox();
   records.push({surface:'editor',width,canvas:bounds});
   await page.screenshot({path:join(output,`refresh-editor-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,name+'-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth));
  if(name==='refresh') {
   const header=await page.locator('.project-topbar').boundingBox();assert.ok(header.height<180,`Mobile header height ${header.height}`);
   assert.equal(await page.getByRole('button',{name:'Сохранить',exact:true}).isVisible(),false);
   const docBefore=(await (await page.request.get(origin+'/api/project?documentId='+doc.id)).json()).state.doc;
   const trigger=page.getByRole('button',{name:'Скачать презентацию',exact:true});
   assert.equal(await trigger.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(37, 37, 34)');
   await trigger.focus();await trigger.press('Enter');
   const panel=page.getByRole('dialog',{name:'Скачать презентацию',exact:true});await panel.waitFor();
   assert.ok(await panel.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
   await page.screenshot({path:join(output,'mobile-download-menu.png'),fullPage:true,animations:'disabled'});
   await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
   assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
   for(const format of ['pdf','pptx']) {
    await trigger.click();
    const downloaded=page.waitForEvent('download',{timeout:30000});
    await panel.getByRole('button',{name:format==='pdf'?/^PDF/:/^PowerPoint/}).click();
    const file=await downloaded;assert.ok(file.suggestedFilename().endsWith('.'+format));
    const target=join(output,'mobile-download.'+format);await file.saveAs(target);
    const bytes=await readFile(target);assert.equal(bytes.subarray(0,format==='pdf'?4:2).toString(),format==='pdf'?'%PDF':'PK');
    await panel.waitFor({state:'hidden'});
   }
   assert.deepEqual((await (await page.request.get(origin+'/api/project?documentId='+doc.id)).json()).state.doc,docBefore);
   records.push({surface:'mobile-header',height:header.height,keyboardMenu:true,escapeRestoresFocus:true,pdfDownloaded:true,pptxDownloaded:true,documentUnchanged:true});
  }
  await page.goto(origin,{waitUntil:'networkidle'});await page.getByRole('heading',{name:name==='refresh'?'Главная':'Все презентации',exact:true}).waitFor();
  await page.screenshot({path:join(output,name+'-library.png'),fullPage:true});
  if(name==='refresh') {
   await page.getByRole('button',{name:'Все презентации',exact:true}).click();
   assert.equal(await page.locator('.library-start').count(),0);assert.equal(new URL(page.url()).hash,'#documents');
   await page.goBack();await page.getByRole('heading',{name:'Главная',exact:true}).waitFor();
   await page.reload({waitUntil:'networkidle'});await page.getByRole('textbox',{name:'Замысел презентации',exact:true}).waitFor();
   for(const width of [768,1280]) {
    await page.setViewportSize({width,height:1000});
    assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth),`Library overflow at ${width}`);
    await page.screenshot({path:join(output,`refresh-library-${width}.png`),fullPage:true});
   }
   await page.setViewportSize({width:390,height:844});
   const idea='Квартальный обзор: результаты, выводы и следующие шаги';
   await page.getByRole('textbox',{name:'Замысел презентации',exact:true}).fill(idea);
   await page.getByRole('button',{name:'Продолжить',exact:true}).click();
   assert.equal(await page.getByRole('textbox',{name:'Задача для новой презентации',exact:true}).inputValue(),idea);
   await page.getByText('Исходные материалы · необязательно',{exact:true}).click();
   await page.getByRole('textbox',{name:'Название исходного материала',exact:true}).fill('Учебный отчёт');
   await page.getByRole('textbox',{name:'Текст исходного материала',exact:true}).fill('Учебные данные: проведено 3 встречи команды.');
   await page.locator('.creation-design-picker>summary').click();
   await page.locator('.creation-design-heading input[value="focus-v2"]').check();
   for(const example of ['cover','content','metrics']) {
    await page.getByLabel('Пример слайда',{exact:true}).selectOption(example);
    assert.equal(await page.locator('.creation-design-preview svg').count(),2);
    for(const preview of await page.locator('.creation-design-preview').all())assert.ok(await preview.evaluate(e=>{const r=e.getBoundingClientRect();return Math.abs(r.width/r.height-16/9)<.04;}));
   }
   await page.screenshot({path:join(output,'design-picker-mobile.png'),fullPage:true});

   await page.locator('.library-generate').getByRole('button',{name:'Отмена',exact:true}).click();
   await page.reload({waitUntil:'networkidle'});
   assert.equal(await page.getByRole('textbox',{name:'Замысел презентации',exact:true}).inputValue(),idea);
   await page.getByRole('button',{name:'Продолжить',exact:true}).click();
   assert.equal(await page.getByRole('textbox',{name:'Текст исходного материала',exact:true}).inputValue(),'Учебные данные: проведено 3 встречи команды.');
   assert.match(await page.locator('.creation-design-picker>summary').textContent(),/Focus 2/);
   await page.locator('.library-generate').getByRole('button',{name:'Отмена',exact:true}).click();

   await page.getByRole('button',{name:'Шаблоны',exact:true}).click();
   assert.equal(new URL(page.url()).hash,'#templates');
   await page.reload({waitUntil:'networkidle'});
   await page.getByRole('heading',{name:'Шаблоны',exact:true}).waitFor();
   assert.equal(await page.locator('.creation-design-preview svg').count(),2);
   for(const width of [390,1280]) {
    await page.setViewportSize({width,height:1000});
    assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth));
    await page.screenshot({path:join(output,`templates-${width}.png`),fullPage:true});
   }
   await page.locator('.creation-design-heading input[value="focus-v3"]').check();
   await page.getByRole('button',{name:'Создать презентацию',exact:true}).click();
   assert.match(await page.locator('.creation-design-picker>summary').textContent(),/Focus 3/);
   assert.equal(await page.getByRole('textbox',{name:'Задача для новой презентации',exact:true}).inputValue(),idea);
   await page.locator('.library-generate').getByRole('button',{name:'Отмена',exact:true}).click();
   await page.goBack();await page.getByRole('heading',{name:'Шаблоны',exact:true}).waitFor();
   await page.getByRole('button',{name:'Создать папку',exact:true}).click();
   await page.getByRole('textbox',{name:'Название папки',exact:true}).fill('Папка из каталога');
   await page.locator('.library-create').getByRole('button',{name:'Создать',exact:true}).click();
   await page.getByRole('button',{name:'Папка из каталога',exact:true}).waitFor();
   await page.reload({waitUntil:'networkidle'});
   await page.getByRole('button',{name:'Папка из каталога',exact:true}).click();
   await page.getByRole('heading',{name:'Папка из каталога',exact:true}).waitFor();
   await page.getByRole('button',{name:'Главная',exact:true}).click();
   await page.setViewportSize({width:390,height:844});

   const menu=page.getByRole('button',{name:'Действия: Проверка стиля · учебный документ',exact:true});
   await menu.click();
   const actions=page.getByRole('dialog',{name:'Действия с презентацией: Проверка стиля · учебный документ',exact:true});
   await actions.waitFor();
   await page.screenshot({path:join(output,'refresh-actions-mobile.png'),fullPage:true});
   assert.ok(await actions.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
   await page.keyboard.press('Escape');await actions.waitFor({state:'hidden'});await menu.focus();
   await page.keyboard.press('Enter');await actions.waitFor();
   assert.equal(await actions.getByRole('combobox').inputValue(),'');
   await actions.getByRole('button',{name:'В корзину: Проверка стиля · учебный документ',exact:true}).click();
   await menu.waitFor({state:'hidden'});
   await page.getByRole('button',{name:'Корзина',exact:true}).click();
   await page.getByRole('button',{name:'Восстановить',exact:true}).click();
   await page.getByRole('button',{name:'Все презентации',exact:true}).click();
   await menu.waitFor();
   const refreshCookie=(await fetch(refresh)).headers.get('set-cookie').split(';')[0];
   const folderResult=await fetch(refresh+'/api/library',{method:'POST',headers:{Cookie:refreshCookie,Origin:refresh,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),command:{action:'create_folder',name:'UX-проверка'}})});
   assert.equal(folderResult.status,200);const folder=await folderResult.json();
   for(let i=0;i<8;i++) {
    const response=await fetch(refresh+'/api/library',{method:'POST',headers:{Cookie:refreshCookie,Origin:refresh,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),command:{action:'create_folder',name:i===7?'Материалы департамента стратегического развития и международного сотрудничества':`Команда ${i+1}`}})});
    assert.equal(response.status,200);
   }
   await page.reload({waitUntil:'networkidle'});
   const navToggle=page.getByRole('button',{name:'Разделы и папки',exact:true});
   await navToggle.focus();await page.keyboard.press('Enter');
   assert.equal(await navToggle.getAttribute('aria-expanded'),'true');
   const mobileNavigation=page.getByRole('navigation',{name:'Библиотека',exact:true});
   assert.ok(await mobileNavigation.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height<=innerHeight*.51;}));
   await page.getByRole('button',{name:'Материалы департамента стратегического развития и международного сотрудничества',exact:true}).scrollIntoViewIfNeeded();
   await page.screenshot({path:join(output,'mobile-folder-navigation.png'),fullPage:true});
   assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth));
   await page.getByRole('button',{name:'Корзина',exact:true}).click();
   assert.equal(await navToggle.getAttribute('aria-expanded'),'false');
   await page.getByRole('heading',{name:'Корзина',exact:true}).waitFor();
   await navToggle.click();await page.getByRole('button',{name:'Все презентации',exact:true}).click();

   await page.reload({waitUntil:'networkidle'});await menu.click();
   await actions.getByRole('combobox').selectOption(folder.id);
   await page.keyboard.press('Escape');await page.reload({waitUntil:'networkidle'});await menu.click();
   assert.equal(await actions.getByRole('combobox').inputValue(),folder.id);
   await actions.getByRole('button',{name:'Создать копию: Проверка стиля · учебный документ',exact:true}).click();
   await page.waitForURL(/\/documents\//);assert.ok(!page.url().includes(doc.id));
   await page.goto(refresh,{waitUntil:'networkidle'});
   await page.getByRole('button',{name:'Список',exact:true}).click();
   await page.locator('.library-list').waitFor();
   assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth));
   await page.getByRole('button',{name:'Карточки',exact:true}).click();
   await page.setViewportSize({width:1600,height:1000});
   await page.screenshot({path:join(output,'refresh-library-desktop.png'),fullPage:true});
  }
  if(name==='refresh') {
   const connection=await (await page.request.get(origin+'/api/connection?documentId='+doc.id)).json();
   const rootIndex=connection.args.indexOf('--root');assert.ok(rootIndex>=0);
   const client=new ProjectClient(connection.args[rootIndex+1]);
   try {
    await client.call('initialize',{});
    const before=await client.tool('get_project');
    const title='Общие знания помогают команде';
    const command={requestId:randomUUID(),deckId:before.state.doc.id,expectedRevision:before.state.revision,title:'Уточнить заголовок',commands:[{op:'set_title',slideId:before.state.doc.slides[0].id,value:title}]};
    const proposed=await client.tool('propose_commands',command);
    assert.deepEqual((await client.tool('get_project')).state.doc,before.state.doc);
    await page.goto(origin+'/#home',{waitUntil:'networkidle'});
    const attention=page.getByRole('region',{name:'Предложения на проверке',exact:true});
    await attention.getByRole('link',{name:/Проверка стиля/}).click();
    await page.getByRole('button',{name:/Принять оставшиеся правки/}).click();
    await page.getByRole('heading',{name:'Нет изменений, ожидающих решения',exact:true}).waitFor();
    await page.reload({waitUntil:'networkidle'});
    const accepted=await client.tool('get_project');const expected=structuredClone(before.state.doc);expected.slides[0].title=title;
    assert.deepEqual(accepted.state.doc,expected);assert.equal(accepted.state.revision,before.state.revision+1);
    assert.equal(accepted.state.proposals.find(p=>p.id===proposed.proposalId).changes[0].status,'accepted');
    await page.goto(origin+'/#home',{waitUntil:'networkidle'});assert.equal(await page.locator('.library-attention').count(),0);
    const rejectedProposal=await client.tool('propose_commands',{...command,requestId:randomUUID(),expectedRevision:accepted.state.revision,title:'Отклоняемая правка',commands:[{op:'set_title',slideId:expected.slides[0].id,value:'Этот заголовок не принимаем'}]});
    await page.goto(origin+'/documents/'+doc.id+'?review=1',{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'Отклонить оставшиеся',exact:true}).click();
    await page.getByRole('heading',{name:'Нет изменений, ожидающих решения',exact:true}).waitFor();
    const rejected=await client.tool('get_project');assert.deepEqual(rejected.state.doc,expected);
    assert.equal(rejected.state.proposals.find(p=>p.id===rejectedProposal.proposalId).changes[0].status,'rejected');
    await client.tool('propose_commands',{...command,requestId:randomUUID(),expectedRevision:rejected.state.revision,title:'Правка к устаревшему заголовку',commands:[{op:'set_title',slideId:expected.slides[0].id,value:'Знания команды'}]});
    const manual=structuredClone(expected);manual.slides[0].title='Правка автора';
    const save=await page.request.post(origin+'/api/project?documentId='+doc.id,{headers:{Origin:origin},data:{requestId:randomUUID(),deckId:manual.id,expectedRevision:rejected.state.revision,command:{action:'save',editorContract:'lanka-editor/3',doc:manual}}});
    assert.equal(save.status(),200);
    await page.goto(origin+'/documents/'+doc.id+'?review=1',{waitUntil:'networkidle'});
    assert.equal(await page.getByRole('button',{name:/Принять оставшиеся правки/}).isDisabled(),true);
    assert.deepEqual((await client.tool('get_project')).state.doc,manual);
    await page.screenshot({path:join(output,'mcp-review-decisions.png'),fullPage:true});
    for(let i=0;i<6;i++){
     const response=await page.request.post(origin+'/api/library',{headers:{Origin:origin},data:{requestId:randomUUID(),command:{action:'create_document',title:'Более новый документ '+i,profile:'focus-v3',folderId:null}}});assert.equal(response.status(),200);
    }
    await page.goto(origin+'/#home',{waitUntil:'networkidle'});
    assert.equal(await page.locator('.library-card').count(),6);
    assert.equal(await page.locator('.library-card').filter({hasText:'Проверка стиля · учебный документ'}).count(),0);
    await attention.getByRole('link',{name:/Проверка стиля/}).waitFor();
    await page.screenshot({path:join(output,'home-pending.png'),fullPage:true});

    await writeFile(join(output,'mcp-review.json'),JSON.stringify({realStdioMcp:true,syntheticResponses:false,modelStarted:false,acceptedTitle:title,acceptPreservedOtherFields:true,rejectPreservedDocument:true,conflictingAcceptanceDisabled:true,homePendingIndependentOfRecency:true,acceptedRemovedFromHome:true,revision:rejected.state.revision},null,2));
   } finally {client.close();}
  }
  await page.close();
 }
 assert.deepEqual(images[0],images[1],'Slide pixels must remain unchanged');
 assert.notEqual(records[0].stageColor,records[1].stageColor);assert.notEqual(records[0].buttonColor,records[1].buttonColor);assert.deepEqual(errors,[]);
 await writeFile(join(output,'result.json'),JSON.stringify({records,errors,slidePixelsUnchanged:true},null,2));console.log(output);
}finally{
 await browser?.close();
 await Promise.all(children.map(c=>new Promise(res=>{if(c.exitCode!==null)return res();c.once('exit',res);c.kill('SIGTERM');})));
 await rm(root,{recursive:true,force:true});
}
