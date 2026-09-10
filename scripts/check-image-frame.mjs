import {resolve} from 'node:path';
import {build} from 'esbuild';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';import {PNG} from 'pngjs';
await mkdir('out/image-frame',{recursive:true});
await build({stdin:{contents:'export {demoDoc,blankSlide} from "./lib/domain/model";export {pdfBytes,pptxBytes} from "./lib/export";export {slideSvg} from "./lib/export-svg";export {SlideCanvas} from "./components/slide-canvas";',resolveDir:process.cwd()},outfile:'out/image-frame-bundle.mjs',bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic'});
const {demoDoc,blankSlide,pdfBytes,pptxBytes,slideSvg,SlideCanvas}=await import(resolve('out/image-frame-bundle.mjs'));
const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
if(!process.argv[2]||!process.argv[3])throw Error('Usage: node scripts/check-image-frame.mjs <bundled sharp module> <bundled soffice>');
const sharp=createRequire(import.meta.url)(resolve(process.argv[2]));
const src=new PNG({width:200,height:100});for(let y=0;y<100;y++)for(let x=0;x<200;x++){let i=(y*200+x)*4;src.data[i]=x<100?255:0;src.data[i+1]=x>=100?255:0;src.data[i+2]=y>=50?255:0;src.data[i+3]=255;}
const bytes=PNG.sync.write(src),data='data:image/png;base64,'+bytes.toString('base64');await writeFile('out/image-frame/source.png',bytes);
const doc=demoDoc();doc.title='Проверка кадрирования';doc.slides=[];
for(const [label,frame] of [['Целиком',{fit:'contain',zoom:1,focusX:.5,focusY:.5}],['Правый край',{fit:'cover',zoom:1,focusX:1,focusY:.5}],['Масштаб и фокус',{fit:'cover',zoom:2,focusX:0,focusY:1}]]){
 const slide=blankSlide();slide.title=label;slide.canvas=[{id:'bg',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'picture',kind:'image',x:300,y:200,w:500,h:500,assetId:'pixels',frame:{sourceWidth:200,sourceHeight:100,...frame}}];doc.slides.push(slide);
}
const load=async()=>({bytes:Uint8Array.from(bytes).buffer,type:'image/png'}),fonts=await Promise.all(['DejaVuSans.ttf','DejaVuSans-Bold.ttf'].map(f=>readFile('public/fonts/'+f)));
await writeFile('out/image-frame/deck.json',JSON.stringify(doc,null,2));await writeFile('out/image-frame/deck.pdf',await pdfBytes(doc,fonts[0],fonts[1],load));await writeFile('out/image-frame/deck.pptx',await pptxBytes(doc,[],load));
execFileSync('pdftoppm',['-scale-to-x','1600','-scale-to-y','900','-png','out/image-frame/deck.pdf','out/image-frame/pdf']);
for(const [i,s] of doc.slides.entries()){
 const svg=slideSvg(s,doc.brand,i,doc.slides.length,doc.design,'',()=>data);await writeFile(`out/image-frame/svg-${i+1}.svg`,svg);await sharp(Buffer.from(svg)).png().toFile(`out/image-frame/svg-${i+1}.png`);
 const html=renderToStaticMarkup(createElement(SlideCanvas,{slide:s,brand:doc.brand,design:doc.design,index:i,total:doc.slides.length})).replace(/href="[^"]*"/g,`href="${data}"`).replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" ');
 await sharp(Buffer.from(html)).png().toFile(`out/image-frame/editor-${i+1}.png`);
 const images=await Promise.all(['svg','editor','pdf'].map(async k=>PNG.sync.read(await readFile(`out/image-frame/${k}-${i+1}.png`))));
 // Sample inside and outside the visible crop, away from antialiased boundaries.
 for(const [x,y] of [[100,100],[350,220],[400,400],[700,400],[400,600],[700,600],[900,700]]){
  const colors=images.map(p=>[...p.data.subarray((y*p.width+x)*4,(y*p.width+x)*4+3)]);
  assert.deepEqual(colors[0],colors[1]);assert.deepEqual(colors[0],colors[2]);
 }
}
console.log('Three image frames: editor SVG, export SVG and PDF pixel samples agree.');

execFileSync(resolve(process.argv[3]),['-env:UserInstallation=file:///tmp/lanka-image-frame-lo','--headless','--convert-to','pdf','--outdir','out/image-frame/pptx-render','out/image-frame/deck.pptx'],{timeout:60000});
execFileSync('pdftoppm',['-scale-to-x','1600','-scale-to-y','900','-png','out/image-frame/pptx-render/deck.pdf','out/image-frame/pptx']);
let maximumChannelDifference=0;
for(let i=1;i<=3;i++){
 const a=PNG.sync.read(await readFile(`out/image-frame/svg-${i}.png`)),b=PNG.sync.read(await readFile(`out/image-frame/pptx-${i}.png`));
 for(const [x,y] of [[100,100],[350,220],[400,400],[700,400],[400,600],[700,600],[900,700]])for(let c=0;c<3;c++){
  const offset=(y*1600+x)*4+c,diff=Math.abs(a.data[offset]-b.data[offset]);maximumChannelDifference=Math.max(maximumChannelDifference,diff);assert.ok(diff<=3,`PPTX sample ${i}/${x},${y}: channel error ${diff}`);
 }
}
await writeFile('docs/planning/evidence/image-frame-render.json',JSON.stringify({date:new Date().toISOString(),cases:['contain','cover-right','cover-zoom-2-bottom-left'],slideCount:3,pixelSamplesPerSlide:7,renderers:['React SlideCanvas SVG via sharp','export SVG via sharp','canonical PDF via Poppler','PPTX via bundled LibreOffice and Poppler'],svgEditorPdfExactSampleAgreement:true,pptxMaximumChannelDifference:maximumChannelDifference,pptxChannelTolerance:3,powerPointDesktopInspected:false,liveBrowserInteractions:false},null,2));
console.log('PPTX rendered crops agree; max RGB channel difference: '+maximumChannelDifference);
