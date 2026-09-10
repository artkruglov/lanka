import {resolve} from 'node:path';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
import sharp from 'sharp';
import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
if(!process.argv[2])throw Error('Pass the bundled soffice path.');
const out='out/data-objects';await mkdir(out,{recursive:true});
const fontConfig=resolve(`${out}/fonts.conf`);await writeFile(fontConfig,`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${resolve('public/fonts')}</dir><cachedir>${resolve(`${out}/font-cache`)}</cachedir></fontconfig>`);
await build({stdin:{contents:`export {demoDoc,blankSlide} from './lib/domain/model';export {scene} from './lib/domain/scene';export {canvasFromScene} from './lib/domain/canvas';export {pdfBytes,pptxBytes} from './lib/export';export {slideSvg} from './lib/export-svg';export {SlideCanvas} from './components/slide-canvas';export {pdfFontFiles} from './lib/domain/scene-typography';`,resolveDir:process.cwd()},outfile:`${out}/bundle.mjs`,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic'});
const {demoDoc,blankSlide,scene,canvasFromScene,pdfBytes,pptxBytes,slideSvg,SlideCanvas,pdfFontFiles}=await import(resolve(`${out}/bundle.mjs`));
for(const design of ['focus-v3','focus-v2']){
 const dir=`${out}/${design}`;await mkdir(dir,{recursive:true});
 const doc=demoDoc();doc.title='Проверка связанных данных';doc.design=design;
 doc.slides=[{...blankSlide(),layout:'chart',title:'Данные изменяются вместе с диаграммой',body:'Синтетические данные для проверки редактора.',chart:[{label:'Исследования',value:25},{label:'Разработка',value:40},{label:'Корректировка',value:-10},{label:'Без изменений',value:0}],chartUnit:'часов'},
 {...blankSlide(),layout:'table',title:'Строки и колонки сохраняют связь',body:'Синтетические данные для проверки редактора.',table:{columns:['Департамент','Задача','Время'],rows:[['Исследования','Проверить сценарий','25'],['Разработка','Обновить диаграмму','40'],['Дизайн','Проверить шаблон','15']],columnRoles:['key','text','number']}}];
 for(const [i,s] of doc.slides.entries()){
  const svg=slideSvg(s,doc.brand,i,doc.slides.length,design);
  const before=await sharp(Buffer.from(svg)).png().toBuffer();
  s.canvas=canvasFromScene(scene(s,doc.brand,i,doc.slides.length,design));
  const after=await sharp(Buffer.from(slideSvg(s,doc.brand,i,doc.slides.length,design))).png().toBuffer();
  assert.equal(hash(after),hash(before),`${design}/${s.layout}: freezing changes pixels`);
  await writeFile(`${dir}/editor-${i+1}.png`,after);
  const react=renderToStaticMarkup(createElement(SlideCanvas,{slide:s,brand:doc.brand,design,index:i,total:doc.slides.length}));
  const reactPng=await sharp(Buffer.from(react.replace('><title','><style>.slide-canvas text { font-family: DejaVu Sans; }</style><title').replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" '))).png().toBuffer();
  assert.equal(hash(reactPng),hash(after),`${design}/${s.layout}: React and export SVG disagree`);
 }
 const fonts=await Promise.all(pdfFontFiles(design).map(n=>readFile(`public/fonts/${n}`)));
 await writeFile(`${dir}/deck.pdf`,await pdfBytes(doc,fonts[0],fonts[1],undefined,fonts[2]));
 await writeFile(`${dir}/deck.pptx`,await pptxBytes(doc));await writeFile(`${dir}/deck.json`,JSON.stringify(doc,null,2));
 execFileSync('pdftoppm',['-scale-to-x','1600','-scale-to-y','900','-png',`${dir}/deck.pdf`,`${dir}/pdf`]);
 execFileSync(resolve(process.argv[2]),['-env:UserInstallation=file:///tmp/lanka-data-objects-lo','--headless','--convert-to','pdf','--outdir',`${dir}/pptx-render`,`${dir}/deck.pptx`],{timeout:60000,env:{...process.env,FONTCONFIG_FILE:fontConfig}});
 execFileSync('pdftoppm',['-scale-to-x','1600','-scale-to-y','900','-png',`${dir}/pptx-render/deck.pdf`,`${dir}/pptx`]);
}
console.log('Four data objects retain exact SVG pixels after conversion. PDF and native PPTX rendered for inspection.');
