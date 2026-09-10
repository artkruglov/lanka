import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import JSZip from 'jszip';
await build({stdin:{contents:`export {pptxBytes} from './lib/export';export {scene,slideCanvasObjects} from './lib/domain/scene';export {canvasFromScene,canvasScene,withCanvas,compactPagination} from './lib/domain/canvas';export {demoDoc,canvasSchema} from './lib/domain/model';`,resolveDir:process.cwd()},outfile:'.project-runtime/canvas-pagination-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {pptxBytes,scene,slideCanvasObjects,canvasFromScene,canvasScene,withCanvas,compactPagination,demoDoc,canvasSchema}=await import('../../.project-runtime/canvas-pagination-test.mjs');
const bound=e=>e.binding==='focus-v3-pagination';
const visible=p=>{const {editField,blockId,id,locked,...rest}=p;return rest;};
for(const [index,total] of [[0,1],[2,5],[19,20],[30,40],[0,2]])test(`frozen Focus 3 pagination follows position ${index+1}/${total} without changing user objects`,()=>{
 const doc=demoDoc(),slide={...doc.slides[0],canvas:undefined};
 const original=canvasFromScene(scene(slide,doc.brand,0,3,'focus-v3'));
 const title=original.find(e=>e.kind==='text'&&e.sourceField==='title');assert.ok(title);title.text='Ручной заголовок';title.x+=15;
 const frozen={...slide,canvas:original},before=structuredClone(original);
 const objects=slideCanvasObjects(frozen,doc.brand,index,total,'focus-v3');
 assert.equal(canvasSchema.safeParse(objects).success,true);
 assert.deepEqual(objects.filter(e=>!bound(e)),original.filter(e=>!bound(e)));
 assert.deepEqual(original,before);
 assert.ok(objects.filter(bound).every(e=>e.locked));
 const actual=scene(frozen,doc.brand,index,total,'focus-v3').items.filter(bound).map(visible);
 const expected=canvasScene(canvasFromScene(scene(slide,doc.brand,index,total,'focus-v3'),true)).items.filter(bound).map(visible);
 assert.deepEqual(actual,expected);
 assert.ok(actual.some(e=>e.kind==='text'&&e.text===`${String(index+1).padStart(2,'0')} / ${String(total).padStart(2,'0')}`));
});
test('legacy unbound canvas and Focus 2 remain unchanged; user IDs never collide with generated IDs',()=>{
 const doc=demoDoc(),slide=doc.slides[0];
 for(const design of ['focus-v2','focus-v3']){
  const legacy=canvasFromScene(scene(slide,doc.brand,0,3,design)).map(e=>{const {binding,...rest}=e;return rest;});
  assert.equal(slideCanvasObjects({...slide,canvas:legacy},doc.brand,2,5,design),legacy);
 }
 const canvas=canvasFromScene(scene(slide,doc.brand,0,3,'focus-v3'));
 const text=canvas.find(e=>e.kind==='text'&&!bound(e));text.id='pagination-0';
 const result=slideCanvasObjects({...slide,canvas},doc.brand,1,4,'focus-v3');
 assert.equal(canvasSchema.safeParse(result).success,true);
 assert.equal(result.find(e=>e.id==='pagination-0'),text);
});

test('a full canvas remains saveable as pagination grows to sixteen slides',()=>{
 const doc=demoDoc(),slide=doc.slides[0];
 const canvas=canvasFromScene(scene(slide,doc.brand,0,1,'focus-v3'));
 while(canvas.length<240)canvas.push({id:`extra-${canvas.length}`,kind:'rect',x:100,y:100,w:10,h:10,color:'#000000'});
 assert.equal(canvasSchema.safeParse(canvas).success,true);
 const frozen={...slide,canvas},objects=slideCanvasObjects(frozen,doc.brand,15,16,'focus-v3');
 assert.ok(objects.length>240);
 const saved=withCanvas(frozen,compactPagination(objects));
 assert.equal(saved.canvas.length,240);
 assert.equal(canvasSchema.safeParse(saved.canvas).success,true);
 assert.deepEqual(saved.canvas.filter(e=>!bound(e)),canvas.filter(e=>!bound(e)));
 const rendered=scene(saved,doc.brand,15,16,'focus-v3').items.filter(bound);
 assert.equal(rendered.filter(e=>e.kind==='rect').length,16);
 assert.equal(rendered.find(e=>e.kind==='text').text,'16 / 16');
});

test('PowerPoint contains updated pagination and native text after reordering a frozen slide',async()=>{
 const doc=demoDoc();doc.design='focus-v3';doc.slides=doc.slides.slice(0,2);
 doc.slides=doc.slides.map(s=>({...s,layout:'cover',title:'Города',body:'Знания и обмен',canvas:undefined}));
 const original=doc.slides[0];doc.slides[0]=withCanvas(original,canvasFromScene(scene(original,doc.brand,0,2,'focus-v3')));
 doc.slides.reverse();
 const zip=await JSZip.loadAsync(await pptxBytes(doc));
 for(let i=1;i<=2;i++){
  const xml=await zip.file(`ppt/slides/slide${i}.xml`).async('string');
  assert.ok(xml.includes(`<a:t>0${i} / 02</a:t>`));
  assert.ok(xml.includes('<a:t>Города</a:t>'));
  assert.ok(!xml.includes('<p:pic>'));
 }
});

test('resolving and saving pagination preserves its existing text anchor identity',()=>{
 const doc=demoDoc(),slide=doc.slides[0],canvas=canvasFromScene(scene(slide,doc.brand,0,2,'focus-v3'));
 const anchor=canvas.find(e=>e.kind==='text'&&bound(e));anchor.id='stable-page-number';
 const resolved=slideCanvasObjects({...slide,canvas},doc.brand,2,3,'focus-v3');
 assert.equal(resolved.find(e=>e.kind==='text'&&bound(e)).id,anchor.id);
 assert.ok(compactPagination(resolved).some(e=>e.id===anchor.id));
});
