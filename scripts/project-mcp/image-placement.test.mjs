import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
await build({stdin:{contents:`export {initialBasicPlacement} from './lib/domain/object-placement';export {initialImagePlacement} from './lib/domain/image-placement';export {boxesOverlap} from './lib/domain/data-layout';`,resolveDir:process.cwd()},outfile:'.project-runtime/image-placement-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {initialBasicPlacement,initialImagePlacement,boxesOverlap}=await import('../../.project-runtime/image-placement-test.mjs');
const rect=(id,x,y,w,h)=>({id,kind:'rect',x,y,w,h,color:'#123456'});
test('new image fits around occupied content while ignoring only the first page background',()=>{
 const objects=[rect('bg',0,0,1600,900),rect('title',150,200,900,150),rect('shape',325,355,950,190)],copy=structuredClone(objects);
 const box=initialImagePlacement(objects);assert.ok(box);assert.ok(box.w>=320);assert.ok(box.x>=16&&box.y>=16&&box.x+box.w<=1584&&box.y+box.h<=884);
 for(const obstacle of objects.slice(1))assert.equal(boxesOverlap(box,obstacle,16),false);
 assert.deepEqual(objects,copy);assert.deepEqual(initialImagePlacement([]),{x:400,y:240,w:800,h:450});
 assert.equal(initialImagePlacement([objects[0],rect('cover',0,0,1600,900)]),undefined);
 assert.equal(initialImagePlacement(Array.from({length:240},(_,i)=>rect(String(i),0,0,1,1))),undefined);
});

await build({stdin:{contents:`export {compileCommands} from './lib/domain/commands';export {assertSelectionChanges} from './lib/domain/selection-changes';export {demoDoc} from './lib/domain/model';`,resolveDir:process.cwd()},outfile:'.project-runtime/image-insertion-command-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {compileCommands,assertSelectionChanges,demoDoc}=await import('../../.project-runtime/image-insertion-command-test.mjs');
test('agent insertion shares placement, preserves neighbours and rejects implicit template conversion and duplicate IDs',()=>{
 const doc=demoDoc(),slide=doc.slides[0];slide.canvas=[rect('bg',0,0,1600,900),rect('content',200,200,1000,250)];const before=structuredClone(doc);
 const command={op:'insert_image',slideId:slide.id,elementId:'new-image',assetId:'registered-image'};
 const changes=compileCommands(doc,[command]),image=changes[0].after.canvas.at(-1);
 assert.deepEqual(doc,before);assert.deepEqual(changes[0].after.canvas.slice(0,-1),slide.canvas);
 assert.deepEqual(image,{id:'new-image',kind:'image',assetId:'registered-image',...initialImagePlacement(slide.canvas)});
 assert.throws(()=>assertSelectionChanges(doc,changes,{slideId:slide.id,elementId:'content'}));
 assert.throws(()=>compileCommands(doc,[{...command,elementId:'content'}]),/already exists/);
 slide.canvas.push(rect('occupied',0,0,1600,900));assert.throws(()=>compileCommands(doc,[command]),/нет свободного места/);
 delete slide.canvas;assert.throws(()=>compileCommands(doc,[command]),/template/);
});

test('new text and shapes find useful free space without covering previous objects',()=>{
 const bg=rect('bg',0,0,1600,900),objects=[bg,rect('title',150,200,900,150),rect('shape',325,355,950,190)],before=structuredClone(objects);
 for(let i=0;i<3;i++){
  const box=initialBasicPlacement(objects);assert.ok(box);assert.ok(box.w>=320&&box.h>=140);
  for(const obstacle of objects.slice(1))assert.equal(boxesOverlap(box,obstacle,16),false);
  assert.ok(box.x>=16&&box.y>=16&&box.x+box.w<=1584&&box.y+box.h<=884);
  objects.push(rect('inserted-'+i,box.x,box.y,box.w,box.h));
 }
 assert.deepEqual(objects.slice(0,3),before);
 assert.equal(initialBasicPlacement([bg,rect('occupied',0,0,1600,900)]),undefined);
 assert.equal(initialBasicPlacement(Array.from({length:240},(_,i)=>rect(String(i),0,0,1,1))),undefined);
});

test('basic MCP insertion measures text before placement, uses brand defaults and preserves scope',()=>{
 const doc=demoDoc();doc.design='focus-v3';const slide=doc.slides[0];slide.canvas=[rect('bg',0,0,1600,900),rect('content',100,100,1000,150)];const before=structuredClone(doc);
 const commands=[{op:'insert_text',slideId:slide.id,elementId:'new-text',value:'Первый абзац\nВторой абзац\nТретий абзац\nЧетвёртый абзац'},{op:'insert_shape',slideId:slide.id,elementId:'new-shape'}];
 const change=compileCommands(doc,commands)[0],objects=change.after.canvas,text=objects[2],shape=objects[3];
 assert.equal(text.font,'sans');assert.equal(text.color,doc.brand.ink);assert.equal(text.size,40);assert.ok(text.h>=4*40*1.3);assert.equal(shape.color,doc.brand.accent);
 assert.deepEqual(doc,before);assert.deepEqual(objects.slice(0,2),slide.canvas);
 for(let i=1;i<objects.length;i++)for(let j=i+1;j<objects.length;j++)assert.equal(boxesOverlap(objects[i],objects[j],16),false);
 assert.throws(()=>assertSelectionChanges(doc,[change],{slideId:slide.id,elementId:'content'}));
 assert.throws(()=>compileCommands(doc,[commands[0],commands[0]]),/already exists/);
 assert.throws(()=>compileCommands(doc,[{...commands[0],value:' '}])) ;
 assert.throws(()=>compileCommands(doc,[{...commands[0],value:'Абзац\n'.repeat(40)}]),/нет свободного места/);
 slide.canvas.push(rect('full',0,0,1600,900));assert.throws(()=>compileCommands(doc,commands),/нет свободного места/);
 delete slide.canvas;assert.throws(()=>compileCommands(doc,commands),/template/);
});
