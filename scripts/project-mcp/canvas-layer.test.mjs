import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
await build({entryPoints:['lib/domain/canvas-layer.ts'],outfile:'.project-runtime/canvas-layer-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {reorderCanvasLayer}=await import('../../.project-runtime/canvas-layer-test.mjs');
const rect=(id,extra={})=>({id,kind:'rect',x:100,y:100,w:300,h:100,color:'#123456',...extra});
test('layer changes preserve content and locked background; edge actions are no-ops',()=>{
 const input=[rect('background',{x:0,y:0,w:1600,h:900,locked:true}),rect('text-underlay'),rect('image'),rect('top')],snapshot=structuredClone(input);
 const back=reorderCanvasLayer(input,'top','back');assert.deepEqual(back.map(o=>o.id),['background','top','text-underlay','image']);
 assert.strictEqual(reorderCanvasLayer(back,'top','backward'),back);
 assert.strictEqual(reorderCanvasLayer(input,'background','front'),input);
 assert.strictEqual(reorderCanvasLayer(input,'top','forward'),input);
 const front=reorderCanvasLayer(back,'top','front');assert.deepEqual(front,input);
 for(const object of back)assert.strictEqual(object,input.find(o=>o.id===object.id));
 assert.deepEqual(input,snapshot);
});
test('one-step ordering works without a background and does not mutate locked objects',()=>{
 const input=[rect('one'),rect('fixed',{locked:true}),rect('three')];
 assert.strictEqual(reorderCanvasLayer(input,'three','backward'),input);
 assert.strictEqual(reorderCanvasLayer(input,'one','forward'),input);
 assert.strictEqual(reorderCanvasLayer(input,'fixed','back'),input);
 assert.strictEqual(reorderCanvasLayer(input,'missing','front'),input);
 assert.strictEqual(reorderCanvasLayer(input,'three','back'),input);
 const unlocked=[rect('one'),rect('two'),rect('three')];assert.deepEqual(reorderCanvasLayer(unlocked,'three','backward').map(o=>o.id),['one','three','two']);assert.deepEqual(reorderCanvasLayer(unlocked,'three','back').map(o=>o.id),['three','one','two']);
});

await build({stdin:{contents:`export {compileCommands} from './lib/domain/commands';export {assertSelectionChanges} from './lib/domain/selection-changes';export {pendingObjects} from './lib/domain/object-review';export {demoDoc} from './lib/domain/model';`,resolveDir:process.cwd()},outfile:'.project-runtime/canvas-layer-command-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {compileCommands,assertSelectionChanges,pendingObjects,demoDoc}=await import('../../.project-runtime/canvas-layer-command-test.mjs');
test('agent layer command preserves selected-object scope and requires whole-slide review',()=>{
 const doc=demoDoc(),slide=doc.slides[0];slide.canvas=[rect('bg',{x:0,y:0,w:1600,h:900,locked:true}),rect('one'),rect('two'),rect('three')];
 const original=structuredClone(doc),commands=[{op:'reorder_element',slideId:slide.id,elementId:'three',direction:'back'}];
 const changes=compileCommands(doc,commands);assert.deepEqual(doc,original);
 assert.deepEqual(changes[0].after.canvas.map(e=>e.id),['bg','three','one','two']);
 assert.doesNotThrow(()=>assertSelectionChanges(doc,changes,{slideId:slide.id,elementId:'three'}));
 assert.equal(pendingObjects({before:slide,after:changes[0].after}),null);
 const neighbour=structuredClone(changes);neighbour[0].after.canvas.find(e=>e.id==='one').color='#ffffff';
 assert.throws(()=>assertSelectionChanges(doc,neighbour,{slideId:slide.id,elementId:'three'}));
 const swapped=structuredClone(changes);[swapped[0].after.canvas[2],swapped[0].after.canvas[3]]=[swapped[0].after.canvas[3],swapped[0].after.canvas[2]];
 assert.throws(()=>assertSelectionChanges(doc,swapped,{slideId:slide.id,elementId:'three'}));
 for(const elementId of ['bg','missing'])assert.throws(()=>compileCommands(doc,[{...commands[0],elementId}]));
 delete slide.canvas;assert.throws(()=>compileCommands(doc,commands),/template/);
});
