// Synthetic corpus for the product's actual size suggestions and exports. No user documents are touched.
import {build} from 'esbuild';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import sharp from 'sharp';
const out=resolve('out/data-resize/render');await mkdir(out,{recursive:true});
await build({stdin:{contents:`export {demoDoc,blankSlide} from './lib/domain/model';export {scene} from './lib/domain/scene';export {canvasFromScene} from './lib/domain/canvas';export {dataSizeOptions} from './lib/domain/data-layout';export {renderDataObject,isDataObject} from './lib/domain/data-object';export {applyDataDraft,applyDataObjectChange} from './lib/domain/data-draft';export {SlideCanvas} from './components/slide-canvas';export {pdfBytes,pptxBytes} from './lib/export';export {pdfFontFiles} from './lib/domain/scene-typography';`,resolveDir:process.cwd()},outfile:resolve(out,'bundle.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic'});
const {demoDoc,blankSlide,scene,canvasFromScene,dataSizeOptions,renderDataObject,isDataObject,applyDataDraft,applyDataObjectChange,SlideCanvas,pdfBytes,pptxBytes,pdfFontFiles}=await import(resolve(out,'bundle.mjs'));
const png=async(s,doc,path)=>{
 const svg=renderToStaticMarkup(createElement(SlideCanvas,{slide:s,brand:doc.brand,design:doc.design})).replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" ').replace('><title','><style>.slide-canvas text { font-family: DejaVu Sans; }</style><title');
 await writeFile(path,await sharp(Buffer.from(svg)).png().toBuffer());
};
const report=[];
for(const design of ['focus-v2','focus-v3']){
 const dir=resolve(out,design);await mkdir(dir,{recursive:true});const exported=demoDoc();exported.design=design;exported.title='Подбор размера данных';exported.slides=[];
 for(const kind of ['chart','table']){
  const doc=demoDoc();doc.design=design;const s={...blankSlide(),layout:kind,title:kind==='chart'?'Работа команды':'Задачи департаментов',body:'Синтетические данные для проверки редактора',chart:[{label:'Исследования',value:25},{label:'Разработка',value:40},{label:'Корректировка',value:-10},{label:'Без изменений',value:0}],chartUnit:'часов',table:{columns:['Команда','Задача','Часы'],columnRoles:['key','text','number'],rows:[['Разработка','Подготовить прототип','25'],['Поддержка','Проверить сценарий','40']]}};
  doc.slides=[s];s.canvas=canvasFromScene(scene(s,doc.brand,0,1,design));const e=s.canvas.find(isDataObject);assert.ok(e);e.w*=.5;e.h*=.3;
  assert.equal(renderDataObject(e).overflow,true);await png(s,doc,resolve(dir,`${kind}-before.png`));const saved=structuredClone(doc);
  const options=dataSizeOptions(e,e,s.canvas);assert.ok(options.length,`${design}/${kind}: no option`);
  for(const [i,option] of options.entries()){
   const value=applyDataDraft({...e,...option.box},e,e),next=applyDataObjectChange(doc,s.id,value,e),slide=next.slides[0];assert.equal(renderDataObject(value).overflow,false);assert.deepEqual(value.data,e.data);assert.deepEqual(slide.canvas.filter(v=>v.id!==e.id),s.canvas.filter(v=>v.id!==e.id));
   await png(slide,next,resolve(dir,`${kind}-${i+1}.png`));exported.slides.push({...slide,id:`${kind}-${i+1}`});
   report.push({design,kind,label:option.label,box:option.box,smallestText:Math.min(...renderDataObject(value).items.filter(p=>p.kind==='text').map(p=>p.size)),neighboursPreserved:true});
  }
  assert.deepEqual(doc,saved);
 }
 const fonts=await Promise.all(pdfFontFiles(design).map(n=>readFile(resolve('public/fonts',n))));
 await writeFile(resolve(dir,'deck.pdf'),await pdfBytes(exported,fonts[0],fonts[1],undefined,fonts[2]));await writeFile(resolve(dir,'deck.pptx'),await pptxBytes(exported));await writeFile(resolve(dir,'deck.json'),JSON.stringify(exported,null,2));
}
await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log(report);
